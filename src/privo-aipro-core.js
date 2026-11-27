// PRIVO AI core: the chat assistant in the AI tab, Free and Pro. Shared by the PRIVO app (browser and server) and the
// tests (test/ai/aipro-core-test.mjs).
// - Both modes answer anything: questions on any topic, markets, PRIVO, writing, ideas. When the trader wants to trade, the
//   reply also carries up to 4 ticket intents. Each intent is checked with the same validate() as Copilot before it reaches
//   the app, and only fills tickets the trader reviews and signs. Nothing here trades or holds keys.
// - Free uses a free model and a short memory. Pro lets the trader pick a model from MODELS, remembers more of the
//   conversation, sees a live price snapshot of PRIVO's markets, and is paid per message: the wallet sends the model's price
//   in USDG (or $PRIVO worth 20% less) to the PRIVO fee wallet, and the server answers once that payment is on chain.
//   Amounts are micro-dollars (1 USD = 1,000,000).
import { MARKETS } from "./privo-swap.js";
import { validate, extractJson, BASKET_THEMES } from "./privo-copilot-core.js";

export const MICRO = 1_000_000;
export const PRIVO_BONUS = 1.25;            // $PRIVO counts at 1.25x its sale value: paying in $PRIVO costs 20% less
export const PAY_MAX_AGE_S = 30 * 60;       // a payment must be used within 30 minutes
export const MAX_INTENTS = 4, FREE_TURNS = 6, PRO_TURNS = 16, SAY_MAX = 6000;
export const usd = micro => "$" + (Number(micro) / MICRO).toFixed(Number(micro) < 10_000 ? 4 : 3).replace(/0$/, "");

/* ---------- Pro models (OpenRouter ids) and their price per message ---------- */
// Each price covers a long message (about 6k tokens in, 1.5k out) at the model's list price, plus about 30%.
export const MODELS = [
  { key: "haiku", id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5", maker: "Anthropic", price: 2000, tag: "Fast" },
  { key: "deepseek", id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", maker: "DeepSeek", price: 2000, tag: "Fast" },
  { key: "glm", id: "z-ai/glm-5.3", label: "GLM 5.3", maker: "Z.ai", price: 4000, tag: "Fast" },
  { key: "gemini-flash", id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash", maker: "Google", price: 15000, tag: "Balanced" },
  { key: "gpt-terra", id: "openai/gpt-6.1-terra", label: "GPT-6.1 Terra", maker: "OpenAI", price: 20000, tag: "Balanced" },
  { key: "grok", id: "x-ai/grok-4.7", label: "Grok 4.7", maker: "xAI", price: 30000, tag: "Balanced" },
  { key: "sonnet", id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5", maker: "Anthropic", price: 40000, tag: "Smart" },
  { key: "gemini-argon", id: "google/gemini-4-argon", label: "Gemini 4 Argon", maker: "Google", price: 40000, tag: "Smart" },
  { key: "gpt-sol", id: "openai/gpt-6.2-sol", label: "GPT-6.2 Sol", maker: "OpenAI", price: 40000, tag: "Smart" },
  { key: "opus", id: "anthropic/claude-opus-5.5", label: "Claude Opus 5.5", maker: "Anthropic", price: 80000, tag: "Strongest" },
  { key: "fable", id: "anthropic/claude-fable-5.2", label: "Claude Fable 5.2", maker: "Anthropic", price: 150000, tag: "Strongest" },
];
export const DEFAULT_MODEL = "haiku";
export const modelByKey = k => MODELS.find(m => m.key === k) || null;
export const PRICE_MICRO = modelByKey(DEFAULT_MODEL).price;

/* ---------- the prompt ---------- */
const live = s => !!MARKETS[s] && !MARKETS[s].delisted;
const isStock = s => live(s) && MARKETS[s].kind === "stock" && !MARKETS[s].native;

// snap: { SYM: [price in USDG, 24h change %] } from the app; only live markets and finite numbers are kept
export function snapshotLine(snap) {
  const out = [];
  for (const [s, v] of Object.entries(snap || {})) {
    if (!live(s) || !Array.isArray(v)) continue;
    const p = +v[0], c = +v[1];
    if (!(p > 0) || !isFinite(p)) continue;
    out.push(s + " " + (p >= 1 ? p.toFixed(2) : p.toPrecision(4)) + (isFinite(c) ? " (" + (c >= 0 ? "+" : "") + c.toFixed(2) + "%)" : ""));
    if (out.length >= 80) break;
  }
  return out.join(", ");
}

export function assistantPrompt({ pro = false, snapshot = "" } = {}) {
  const stocks = Object.keys(MARKETS).filter(isStock), crypto = Object.keys(MARKETS).filter(s => live(s) && !isStock(s));
  return [
    `You are PRIVO AI${pro ? " Pro" : ""}, the assistant inside PRIVO, a trading app on Robinhood Chain for tokenized stocks and crypto (spot via Uniswap with a 0.15% PRIVO fee, perps via Orderly, a private Block desk, limit and TWAP orders, baskets, Arena, copy trading, gifts).`,
    "You can talk about anything: answer questions on any topic, explain markets, stocks, crypto, trading ideas and strategies, how PRIVO works, and help with writing, math, code or anything else the trader asks. Be direct, useful and friendly; reply in the trader's language.",
    pro ? "Give thorough, well-structured answers: short paragraphs, bullet points and **bold** for key points when that helps. Use the live snapshot below for prices and moves; say when something needs data you do not have." : "Keep answers clear and reasonably short.",
    "When you discuss markets or give a view, explain your reasoning and the risks, never promise returns, and note that it is not financial advice and the trader decides. Do not invent live prices, balances or news.",
    "When the trader wants to trade on PRIVO, add tickets. You never trade, sign or move funds: the trader reviews and signs each ticket in their own wallet.",
    "This is a conversation: use earlier turns for follow-ups like \"make it 50\", \"same for AMD\", \"now as a limit at 170\".",
    "Reply with ONE JSON object only, no code fences: {\"say\":\"your answer\",\"intents\":[]}",
    "\"intents\": 0 to " + MAX_INTENTS + " tickets, only when the trader asks to trade, in the order to sign them. Shapes (plain numbers; at most one of usdg, qty, pct):",
    '{"type":"spot","side":"buy"|"sell","sym":"TSLA","usdg":50} usdg = USDG to spend (buy) or the USDG value to sell; qty = tokens; pct = percent of the balance',
    '{"type":"limit","side":"buy"|"sell","sym":"TSLA","usdg":100,"price":380,"days":7} price = worst USDG per token; stock tokens only',
    '{"type":"twap","side":"buy"|"sell","sym":"TSLA","qty":3,"price":400,"slices":6,"everyMin":15,"days":1} stock tokens only',
    '{"type":"basket","legs":[{"sym":"NVDA","pct":60},{"sym":"AMD","pct":40}],"usdg":90,"name":"Chips"} 2 to 8 stock tokens, pct adds up to 100',
    '{"type":"rebalance","basket":"Big Tech"}   {"type":"open","sym":"NVDA"}',
    "Basket themes: " + BASKET_THEMES.map(([n, s]) => n + " = " + s.join(" ")).join("; ") + ".",
    "Stock tokens on PRIVO: " + stocks.join(" ") + ".",
    "Crypto on PRIVO (spot only): " + crypto.join(" ") + ".",
    snapshot ? "Live snapshot (price in USDG, 24h change), " + new Date().toISOString().slice(0, 16) + " UTC: " + snapshot : "",
  ].filter(Boolean).join("\n");
}
// kept for older callers
export const proSystemPrompt = () => assistantPrompt({ pro: true });

/* ---------- the conversation sent to the model ---------- */
// msgs: the AI tab's messages ({ role: "user", text } | { role: "ai", say?, intents?, intent?, error?, info? }). Returns
// OpenAI-style messages, newest last, the last `turns` of them, each trimmed. Nothing else about the trader is sent.
export function historyFor(msgs, turns = PRO_TURNS) {
  const out = [];
  for (const m of (msgs || []).slice(-turns)) {
    if (m.role === "user" && m.text) out.push({ role: "user", content: String(m.text).slice(0, 2000) });
    else if (m.role === "ai") {
      const intents = m.intents || (m.intent ? [m.intent] : []);
      const say = String(m.say || m.error || (m.info ? "(showed " + m.info.type + (m.info.sym ? " for " + m.info.sym : "") + ")" : "")).slice(0, 1500);
      out.push({ role: "assistant", content: JSON.stringify({ say, intents }) });
    }
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

/* ---------- reading the model's reply ---------- */
// -> { say, intents: [checked intents], dropped: [reasons] }. Never throws; a reply that is not JSON is the answer itself.
export function parseProReply(content) {
  const raw = String(content || "");
  const obj = extractJson(raw);
  if (!obj || typeof obj !== "object" || (obj.say == null && obj.intents == null && !obj.type)) {
    const text = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim().slice(0, SAY_MAX);
    return { say: text || "I could not answer that. Try asking again.", intents: [], dropped: [] };
  }
  const say = String(obj.say || "").trim().slice(0, SAY_MAX);
  const list = Array.isArray(obj.intents) ? obj.intents : obj.type ? [obj] : [];
  const intents = [], dropped = [];
  for (const x of list.slice(0, MAX_INTENTS)) {
    if (x?.type === "help" || x?.type === "none") continue;
    const v = validate(x);
    if (v.ok) intents.push(v.intent); else dropped.push(v.error);
  }
  return { say: say || (intents.length ? "Here are the tickets. Check each one and sign if it looks right." : "I could not answer that. Try asking again."), intents, dropped };
}

/* ---------- payments (Pro) ---------- */
// What a payment is worth in micro-dollars. USDG: raw USDG (6 decimals, so already micro-dollars). PRIVO: privoUsdgOut is
// the raw USDG a sale of that $PRIVO would return now (after pool fees), counted at PRIVO_BONUS.
export function paymentValue({ token, raw, privoUsdgOut }) {
  if (token === "USDG") return Number(BigInt(raw));
  if (token === "PRIVO") return Math.floor(Number(privoUsdgOut) * PRIVO_BONUS);
  return 0;
}
// Enough for one message? $PRIVO gets 5% slack for the price moving between the wallet's quote and the server's check.
export const covers = (value, token, price = PRICE_MICRO) => value >= (token === "PRIVO" ? Math.floor(price * 0.95) : price);
// How much $PRIVO to send for one message, given the raw USDG a sale of `probe` raw $PRIVO returns now: 20% under the model's
// price (PRIVO covers the rest), plus 3% for the price moving before the server checks it (the server allows 5%).
export function privoFor(probe, probeUsdgOut, price = PRICE_MICRO) {
  const perUnit = Number(probeUsdgOut) / Number(probe);
  if (!(perUnit > 0)) throw new Error("No $PRIVO price right now");
  return BigInt(Math.ceil(price / PRIVO_BONUS / perUnit * 1.03));
}
