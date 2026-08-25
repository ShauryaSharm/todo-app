// Groq retires models on its own schedule, and a hardcoded name silently breaks
// every AI feature at once (that's exactly what happened when llama-3.1-8b-instant
// was pulled). Try a chain instead and use whichever the key can actually reach.
// GROQ_MODEL, when set in Vercel, is always tried first.
const MODEL_CHAIN = [
  process.env.GROQ_MODEL,
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "llama-3.1-8b-instant",
].filter(Boolean);

export async function groqChat(body) {
  const key = (process.env.GROQ_API_KEY || "").trim();
  if (!key) throw new Error("GROQ_API_KEY is not set");

  const tried = [];
  for (const model of MODEL_CHAIN) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, model }),
    });
    if (res.ok) return { data: await res.json(), model };

    const detail = (await res.text()).slice(0, 160);
    tried.push(`${model}->${res.status}`);
    // A bad key fails identically for every model, so stop rather than hammering.
    if (res.status === 401 || res.status === 403) {
      throw new Error(`auth failed (${res.status}): ${detail}`);
    }
  }
  throw new Error(`no usable model. tried: ${tried.join(", ")}`);
}
