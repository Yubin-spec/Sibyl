import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read = name => readFile(new URL(name, import.meta.url), 'utf8');

test('observer page renders a chronological read-only pipeline', async () => {
  const [html, js, css] = await Promise.all([read('desktop.html'), read('desktop.js'), read('desktop.css')]);
  const start = html.indexOf('id="page-observer"');
  const end = html.indexOf('</section>', start);
  const section = html.slice(start, end + '</section>'.length);
  assert.match(section, /id="observerPipeline"/);
  assert.match(section, /id="observerTimeline"/);
  assert.doesNotMatch(section, /<button|<form|<input|<textarea|<select/i);
  assert.match(html, /type="module"/);

  const fnStart = js.indexOf('function renderObserver()');
  const fnEnd = js.indexOf("$('refreshActivity').onclick", fnStart);
  const body = js.slice(fnStart, fnEnd);
  assert.match(body, /observerPipeline/);
  assert.match(body, /observerTimeline/);
  assert.doesNotMatch(body, /\bapi\(/);
  assert.doesNotMatch(body, /\bbutton\(/);

  assert.match(js, /\/observer-model\.mjs/);
  assert.match(css, /\.timeline-item/);
  assert.match(css, /\.pipeline-stage/);
});

test('observer rendering never references session secrets', async () => {
  const js = await read('desktop.js');
  const start = js.indexOf('function observerStatusClass');
  const end = js.indexOf("$('refreshActivity').onclick", start);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(js.slice(start, end), /host\?\.code|pairing|\.token|bridge-session|x-bridge-ui/i);
});

test('desktop UI exposes a read-only observer page', async () => {
  const [html, js, css] = await Promise.all([read('desktop.html'), read('desktop.js'), read('desktop.css')]);

  assert.match(html, /data-page="observer"/);
  assert.match(html, /id="page-observer"/);
  const start = html.indexOf('id="page-observer"');
  const end = html.indexOf('</section>', start);
  assert.ok(start > 0 && end > start);
  const section = html.slice(start, end + '</section>'.length);
  assert.doesNotMatch(section, /<button|<form|<input|<textarea|<select/i);

  assert.match(js, /workers:\[\]/);
  assert.match(js, /planReviews:\[\]/);
  assert.match(js, /renderObserver\(\);/);
  const fnStart = js.indexOf('function renderObserver()');
  const fnEnd = js.indexOf("\n$('refreshActivity').onclick", fnStart);
  assert.ok(fnStart > 0 && fnEnd > fnStart);
  const body = js.slice(fnStart, fnEnd);
  assert.doesNotMatch(body, /\bapi\(/);
  assert.doesNotMatch(body, /\bbutton\(/);

  assert.match(css, /\.observer-fields/);
  assert.match(css, /\.observer-pill/);
});
