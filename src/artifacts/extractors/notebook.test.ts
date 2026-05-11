import test from 'node:test'
import assert from 'node:assert/strict'

import { notebookExtractor } from './notebook.js'

function notebook(json: unknown): Buffer {
  return Buffer.from(JSON.stringify(json), 'utf8')
}

test('notebook: flattens code + markdown cells with stream outputs', async () => {
  const buf = notebook({
    cells: [
      {
        cell_type: 'code',
        source: ['import pandas as pd\n', 'df = pd.read_csv("x.csv")\n'],
        outputs: [{ output_type: 'stream', text: 'Loaded\n' }],
      },
      {
        cell_type: 'markdown',
        source: '## Analysis\n',
      },
      {
        cell_type: 'code',
        source: 'df.head()',
        outputs: [
          {
            output_type: 'execute_result',
            data: { 'text/plain': '   a  b\n0  1  2' },
          },
        ],
      },
    ],
    metadata: { kernelspec: { name: 'python3' } },
  })
  const result = await notebookExtractor.extract({
    buffer: buf,
    filePath: 'analysis.ipynb',
    maxChars: 10_000,
  })
  assert.equal(result.format, 'notebook')
  assert.equal(result.truncated, false)
  assert.match(result.text, /\[Cell 1, code\]/)
  assert.match(result.text, /import pandas/)
  assert.match(result.text, /\[Cell 1 output, stream\]/)
  assert.match(result.text, /Loaded/)
  assert.match(result.text, /\[Cell 2, markdown\]/)
  assert.match(result.text, /## Analysis/)
  assert.match(result.text, /\[Cell 3 output, execute_result\]/)
  assert.match(result.text, /a  b/)
  assert.equal(result.metadata?.kernel, 'python3')
  assert.equal(result.metadata?.cellCount, 3)
})

test('notebook: marks visual outputs as placeholders, never inlines image data', async () => {
  const buf = notebook({
    cells: [
      {
        cell_type: 'code',
        source: 'plot(df)',
        outputs: [
          {
            output_type: 'display_data',
            data: { 'image/png': 'AAAAAA'.repeat(100) },
          },
        ],
      },
    ],
  })
  const result = await notebookExtractor.extract({
    buffer: buf,
    filePath: 'plot.ipynb',
    maxChars: 10_000,
  })
  // Image data must not leak into the flattened text.
  assert.equal(result.text.includes('AAAAAA'), false)
  assert.match(result.text, /\[Cell 1 output, image\/png\]/)
  assert.match(result.text, /visual output/)
})

test('notebook: error output is preserved with traceback', async () => {
  const buf = notebook({
    cells: [
      {
        cell_type: 'code',
        source: '1/0',
        outputs: [
          {
            output_type: 'error',
            ename: 'ZeroDivisionError',
            evalue: 'division by zero',
            traceback: ['Traceback (most recent call last):', '  File "x", line 1', 'ZeroDivisionError: division by zero'],
          },
        ],
      },
    ],
  })
  const result = await notebookExtractor.extract({
    buffer: buf,
    filePath: 'err.ipynb',
    maxChars: 10_000,
  })
  assert.match(result.text, /\[Cell 1 output, error: ZeroDivisionError\]/)
  assert.match(result.text, /division by zero/)
  assert.match(result.text, /Traceback/)
})

test('notebook: invalid JSON returns raw text with warning, no crash', async () => {
  const buf = Buffer.from('{not valid json', 'utf8')
  const result = await notebookExtractor.extract({
    buffer: buf,
    filePath: 'broken.ipynb',
    maxChars: 100,
  })
  assert.equal(result.format, 'notebook')
  assert.equal(result.text, '{not valid json')
  assert.match(result.warnings[0] ?? '', /parse failed/i)
})
