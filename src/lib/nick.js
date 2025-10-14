// src/lib/nick.js (ESM)
export function tagForCargo(cargo) {
  if (!cargo) return "ESTG";
  if (/agt/i.test(cargo)) return "AGT 3";
  if (/pf/i.test(cargo)) return "PF";
  if (/est/i.test(cargo)) return "ESTG";
  return String(cargo).toUpperCase();
}

export function buildNickname({ nome, passport, cargo }) {
  const TAG = tagForCargo(cargo);
  const cleanName = (nome || "").trim();
  return `[${TAG}] ${cleanName} | ${passport}`;
}

export function extractPassportFromNick(nickname) {
  const m = nickname?.match(/\|\s*(\d+)\s*$/);
  return m ? m[1] : null;
}
