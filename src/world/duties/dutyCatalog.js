const EMPTY_CATALOG = Object.freeze({
  schemaVersion: 1,
  duties: [],
  unavailable: true,
});

function normalizeCatalog(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.duties)) return { ...EMPTY_CATALOG };
  const duties = value.duties.filter(duty => duty && typeof duty === 'object' && typeof duty.dutyKey === 'string' && duty.dutyKey.trim());
  return {
    schemaVersion: Number.isFinite(Number(value.schemaVersion)) ? Number(value.schemaVersion) : 1,
    duties,
    unavailable: false,
  };
}

export async function loadDutyCatalog() {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}duties/catalog.json`, { cache: 'no-store' });
    if (!response.ok) return { ...EMPTY_CATALOG };
    return normalizeCatalog(await response.json());
  } catch {
    return { ...EMPTY_CATALOG };
  }
}
