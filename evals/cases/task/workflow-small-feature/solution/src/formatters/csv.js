const COLUMNS = ['name', 'status', 'note'];

function escapeField(value) {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function formatCsv(records) {
  const rows = records.map((record) =>
    COLUMNS.map((column) => escapeField(record[column])).join(','),
  );
  return [COLUMNS.join(','), ...rows].join('\n');
}
