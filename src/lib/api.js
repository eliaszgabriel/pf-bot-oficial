// src/lib/api.js (ESM)
const fetch = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));

const API_BASE = process.env.API_BASE;
const API_TOKEN = process.env.API_TOKEN;

function authHeaders(json = true) {
  const h = { Authorization: `Bearer ${API_TOKEN}` };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

export async function getRecruitByPassport(passport) {
  const url = `${API_BASE}/api/recruits?passport=${encodeURIComponent(
    passport
  )}`;
  const res = await fetch(url, { headers: authHeaders(false) });
  if (!res.ok) throw new Error(`API getRecruitByPassport ${res.status}`);
  return res.json();
}

export async function getMonthlyRank(limit = 10) {
  const url = `${API_BASE}/api/recruits/rank?limit=${limit}`;
  const res = await fetch(url, { headers: authHeaders(false) });
  if (!res.ok) throw new Error(`API getMonthlyRank ${res.status}`);
  return res.json();
}
