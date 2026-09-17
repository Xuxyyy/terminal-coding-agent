const COLUMNS = ['name', 'status', 'note'];

export function formatCsv(records) {
  const rows = records.map((record) =>
    COLUMNS.map((column) => record[column]).join(','),
  );
  return [COLUMNS.join(','), ...rows].join('\n');
}
