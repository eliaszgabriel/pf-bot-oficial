// helpers/api.js (ESM)
import axios from "axios";

const api = axios.create({
  baseURL: process.env.PF_API_URL, // ex.: https://api.pfrecrutamento.win
  timeout: 8000,
  headers: {
    Authorization: `Bearer ${process.env.PF_API_TOKEN}`,
    "Content-Type": "application/json",
  },
});

// Recrutamento — insere/atualiza status/cargo
export async function upsertRecruit(payload) {
  if (!process.env.PF_API_URL) return;
  try {
    await api.post("/api/recruits/upsert", payload);
  } catch (e) {
    console.error("[API] upsertRecruit:", e.response?.data || e.message);
  }
}

// Jurídico — tolerante a 404/501 caso a rota não exista ainda
export async function upsertJuridico(payload) {
  if (!process.env.PF_API_URL) return;
  try {
    await api.post("/api/juridico/upsert", payload);
  } catch (e) {
    console.warn(
      "[API] upsertJuridico:",
      e.response?.status,
      e.response?.data || e.message
    );
  }
}
