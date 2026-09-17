import assert from 'node:assert/strict';
import test from 'node:test';
import {renderReport} from '../src/index.js';

const records = [
  {name: 'Deploy', status: 'ready', note: 'Ship at noon'},
  {name: 'Review', status: 'blocked', note: 'Waiting for approval'},
];

test('renders the default text report', () => {
  assert.equal(
    renderReport(records),
    'Deploy [ready] Ship at noon\nReview [blocked] Waiting for approval',
  );
});

test('renders a JSON report', () => {
  assert.equal(renderReport(records, {format: 'json'}), JSON.stringify(records, null, 2));
});

test('renders a CSV report', () => {
  const csvRecords = [
    {name: 'North, Inc.', status: 'ready', note: 'plain'},
  ];
  assert.equal(
    renderReport(csvRecords, {format: 'csv'}),
    'name,status,note\nNorth, Inc.,ready,plain',
  );
});

test('renders a CSV header for an empty report', () => {
  assert.equal(renderReport([], {format: 'csv'}), 'name,status,note');
});

test('normalizes missing public fields', () => {
  assert.equal(
    renderReport([{name: 'Draft'}]),
    'Draft []',
  );
});

test('rejects an unknown report format', () => {
  assert.throws(
    () => renderReport(records, {format: 'yaml'}),
    /unsupported report format: yaml/,
  );
});
