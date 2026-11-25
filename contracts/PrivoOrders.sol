// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20Balance {
    function balanceOf(address) external view returns (uint256);
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @title PRIVO Orders: limit orders and TWAP on Robinhood Chain
/// @notice A maker signs an EIP-712 Order off chain: sell `amountIn` of `tokenIn` for at least `minAmountOut` of `tokenOut`,
/// in `slices` equal parts at least `interval` seconds apart (slices = 1 is a plain limit order). The maker approves this
/// contract for `tokenIn` once; nothing moves until a slice is filled.
/// A fill pulls one slice from the maker straight into the Uniswap Universal Router, swaps it there with the route the
/// filler supplies, and pays the output to the maker. The fill reverts unless the maker receives at least that slice's
/// share of `minAmountOut` after the fee, and unless the router spent the whole slice.
/// Only the filler the maker named may fill (or anyone, when the maker names address(0)). The filler chooses the route
/// and the moment, never the minimum: a filler can only fill at or better than the maker's own limit.
/// The contract never holds funds between transactions, has no owner, no admin, no upgrade path and no pause switch.
/// Fee: 0.15% of the USDG leg, the same as PRIVO spot, sent to the PRIVO fee Safe.
contract PrivoOrders {
    /// PRIVO fee Safe (2 of 3) on Robinhood Chain.
    address public constant FEE_WALLET = 0xCc051cf47547386bA147FDDfcBCFE00E791C1418;
    /// USDG on Robinhood Chain. Every order has USDG on one side.
    address public constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    /// Uniswap Universal Router on Robinhood Chain.
    address public constant ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    uint256 public constant FEE_BIPS = 15;
    uint256 public constant MAX_SLICES = 100;

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address filler,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint32 slices,uint32 interval,uint64 start,uint64 deadline,uint256 nonce)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("PRIVO Orders");
    bytes32 private constant VERSION_HASH = keccak256("1");

    struct Order {
        address maker;        // signer; receives the output
        address filler;       // the only address allowed to fill, or address(0) for anyone
        address tokenIn;      // what the maker sells
        address tokenOut;     // what the maker receives
        uint256 amountIn;     // total to sell over all slices
        uint256 minAmountOut; // total the maker must receive over all slices, after the fee
        uint32 slices;        // 1 = limit order, more = TWAP
        uint32 interval;      // seconds between slices
        uint64 start;         // unix seconds; slice i can fill from start + i * interval
        uint64 deadline;      // unix seconds; no fill after this
        uint256 nonce;        // per maker; cancel(nonce) withdraws the order
    }

    /// order hash => slices filled so far
    mapping(bytes32 => uint256) public slicesFilled;
    /// maker => nonce => cancelled
    mapping(address => mapping(uint256 => bool)) public nonceCancelled;
    uint256 private _locked; // 0 = free, 1 = inside fill (no initializer needed)

    event Filled(bytes32 indexed orderHash, address indexed maker, uint256 slice, uint256 amountIn, uint256 amountOut, uint256 fee);
    event OrderCancelled(address indexed maker, uint256 indexed nonce);

    error NotFiller();
    error Expired();
    error TooEarly();
    error BadOrder();
    error OrderCancelledError();
    error OrderDone();
    error BadSignature();
    error BelowLimit();
    error InputLeftInRouter();
    error Reentrancy();
    error TransferFailed(address token, address from, address to, uint256 amount);

    modifier nonReentrant() {
        if (_locked == 1) revert Reentrancy();
        _locked = 1;
        _;
        _locked = 0;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function hashOrder(Order calldata o) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            ORDER_TYPEHASH, o.maker, o.filler, o.tokenIn, o.tokenOut, o.amountIn, o.minAmountOut, o.slices, o.interval, o.start, o.deadline, o.nonce
        ));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice Size of slice `i`, and the least the maker must receive for it (after the fee, rounded up).
    function slice(Order calldata o, uint256 i) public pure returns (uint256 amountIn, uint256 minOut) {
        uint256 part = o.amountIn / o.slices;
        amountIn = i + 1 == o.slices ? o.amountIn - part * (o.slices - 1) : part;
        minOut = (o.minAmountOut * amountIn + o.amountIn - 1) / o.amountIn;
    }

    /// @notice Fills the next slice of an order. `commands` and `inputs` are the Universal Router route for this slice:
    /// they spend the router's balance of tokenIn (the slice is sent there first) and send tokenOut to this contract.
    function fill(Order calldata o, bytes calldata signature, bytes calldata commands, bytes[] calldata inputs)
        external nonReentrant returns (uint256 received)
    {
        (bytes32 h, uint256 i) = _take(o, signature);
        received = _settle(o, h, i, commands, inputs);
    }

    /// Checks the order and claims slice i (state is updated before any token moves).
    function _take(Order calldata o, bytes calldata signature) internal returns (bytes32 h, uint256 i) {
        if (o.filler != address(0) && msg.sender != o.filler) revert NotFiller();
        if (block.timestamp > o.deadline) revert Expired();
        if (o.slices == 0 || o.slices > MAX_SLICES || o.amountIn < o.slices || o.minAmountOut == 0 || o.tokenIn == o.tokenOut
            || (o.tokenIn != USDG && o.tokenOut != USDG) || o.maker == address(0)) revert BadOrder();
        if (nonceCancelled[o.maker][o.nonce]) revert OrderCancelledError();
        h = hashOrder(o);
        i = slicesFilled[h];
        if (i >= o.slices) revert OrderDone();
        if (block.timestamp < uint256(o.start) + i * uint256(o.interval)) revert TooEarly();
        if (!_validSignature(o.maker, h, signature)) revert BadSignature();
        slicesFilled[h] = i + 1;
    }

    /// Takes the fee on the USDG leg, swaps the slice and pays the maker, or reverts below the maker's limit.
    function _settle(Order calldata o, bytes32 h, uint256 i, bytes calldata commands, bytes[] calldata inputs)
        internal returns (uint256 received)
    {
        (uint256 inPart, uint256 minOut) = slice(o, i);
        uint256 fee = o.tokenIn == USDG ? inPart * FEE_BIPS / 10_000 : 0;
        if (fee != 0) _pull(USDG, o.maker, FEE_WALLET, fee);
        uint256 out = _swap(o, inPart - fee, commands, inputs);
        if (o.tokenOut == USDG) {
            fee = out * FEE_BIPS / 10_000;
            if (fee != 0) _push(USDG, FEE_WALLET, fee);
            received = out - fee;
        } else {
            received = out;
        }
        if (received < minOut) revert BelowLimit();
        _push(o.tokenOut, o.maker, received);
        emit Filled(h, o.maker, i, inPart, received, fee);
    }

    /// Sends the slice from the maker into the router, runs the route, and returns what this contract received.
    function _swap(Order calldata o, uint256 swapIn, bytes calldata commands, bytes[] calldata inputs) internal returns (uint256 out) {
        uint256 routerInBefore = IERC20Balance(o.tokenIn).balanceOf(ROUTER);
        uint256 outBefore = IERC20Balance(o.tokenOut).balanceOf(address(this));
        _pull(o.tokenIn, o.maker, ROUTER, swapIn);
        IUniversalRouter(ROUTER).execute(commands, inputs, block.timestamp);
        // the route must spend the whole slice: nothing of it may stay in the router for someone else to sweep
        if (IERC20Balance(o.tokenIn).balanceOf(ROUTER) > routerInBefore) revert InputLeftInRouter();
        out = IERC20Balance(o.tokenOut).balanceOf(address(this)) - outBefore;
    }

    /// @notice The maker withdraws an order (all its unfilled slices) before it is filled.
    function cancel(uint256 nonce) external {
        nonceCancelled[msg.sender][nonce] = true;
        emit OrderCancelled(msg.sender, nonce);
    }

    function _validSignature(address signer, bytes32 digest, bytes calldata sig) internal view returns (bool) {
        if (signer.code.length > 0) {
            // ERC-1271 smart contract wallets (e.g. a Safe)
            (bool ok, bytes memory ret) = signer.staticcall(abi.encodeWithSelector(0x1626ba7e, digest, sig));
            return ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == 0x1626ba7e;
        }
        if (sig.length != 65) return false;
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        // reject malleable signatures (upper half s)
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return false;
        address got = ecrecover(digest, v, r, s);
        return got != address(0) && got == signer;
    }

    function _pull(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool))) || token.code.length == 0) revert TransferFailed(token, from, to, amount);
    }

    function _push(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool))) || token.code.length == 0) revert TransferFailed(token, address(this), to, amount);
    }
}
