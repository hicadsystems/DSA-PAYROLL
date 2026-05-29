
// payded excel helpers


export function rowSignature(row) {
  const sortedKeys = Object.keys(row).sort();
  const normalized = {};

  for (const key of sortedKeys) {
    const value = row[key];
    normalized[key] = typeof value === "string" ? value.trim() : value;
  }

  return JSON.stringify(normalized);
}

export function deduplicate(rows) {
  const seen = new Set();
  const cleaned = [];
  const duplicates = [];

  for (const row of rows) {
    const sig = rowSignature(row);
    if (!seen.has(sig)) {
      seen.add(sig);
      cleaned.push(row);
    } else {
      duplicates.push(row);
    }
  }

  return { cleaned, duplicates };
}

export function normalize(row) {
  const normalized = {};

  for (const key in row) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;

    const normalizedKey = key
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "") // remove non-alphanumeric (keeps spaces for now)
      .replace(/\s+/g, "_") // convert whitespace to _
      .replace(/^_+|_+$/g, ""); // strip leading/trailing underscores

    if (!normalizedKey) continue; // skip keys that became empty

    normalized[normalizedKey] = row[key];
  }

  return normalized;
}

// Helper function to parse CSV file
export function parseCSVFile(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (data) => results.push(data))
      .on("end", () => resolve(results))
      .on("error", (error) => reject(error));
  });
}


export function generateBatchName(prefix = 'batch', createdBy = 'SYSTEM') {
  const iso = new Date().toLocaleDateString('en-NG', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).split('/').reverse().join('-');
  const safePrefix = prefix.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safePrefix}_${createdBy}_${iso}`;
}