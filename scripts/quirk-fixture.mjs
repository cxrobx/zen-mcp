#!/usr/bin/env node
// Local fixture site for the nav-memory quirk eval (scripts/nav-memory-quirk-eval.mjs).
// Each quirk page carries one learnable fact of a class the note store already
// records on real sites; variant 2 of a page makes that fact false at the same
// path, so notes learned on variant 1 still attach. Placeholder content only.
//
//   node scripts/quirk-fixture.mjs --host <lan-ip> [--port 18931] [--frame-port 18932]
//
// Serve on a LAN address, not localhost: nav-memory ignores dev hosts by design.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const STYLE = 'body{font:16px/1.5 system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px}input,select,button,textarea{font:inherit;padding:4px 8px;margin:4px 0}section{border:1px solid #bbb;padding:12px;margin:12px 0}table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:4px 10px;text-align:left}iframe{border:1px solid #bbb}';
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>${STYLE}</style></head><body>${body}</body></html>`;

const PREFIXES = ['AK', 'BN', 'CT', 'DV', 'EW', 'FX', 'GY', 'HZ'];
const CUSTOMERS = ['Harbor Cafe', 'Pine Street Books', 'Northside Cycles', 'Lumen Studio', 'Atlas Hardware', 'Quill Stationery'];
const STATUSES = ['Shipped', 'Processing', 'Delivered', 'Cancelled', 'Refunded'];
export const ORDERS = Array.from({ length: 40 }, (_, i) => ({ id: `${PREFIXES[i % 8]}-${101 + i * 13}`, customer: CUSTOMERS[i % CUSTOMERS.length], status: STATUSES[(i * 3) % 5] }));
ORDERS[12] = { id: 'ZX-417', customer: 'Harbor Cafe', status: 'Refunded' };
const INVOICES = { february: '$3,975.00', march: '$4,310.00' };

const pages = {
  index: () => page('Workbench', '<h1>Workbench</h1><p>Demo workspace.</p><ul>' + ['nickname', 'checkout', 'invoices', 'ticket', 'settings', 'workspaces', 'orders', 'waitlist', 'city', 'rates'].map(p => `<li><a href="/${p}">${p}</a></li>`).join('') + '</ul>'),

  // timing: the field accepts input only after a delayed unlock; an early fill is discarded.
  nickname: v => v === 1 ? page('Profile nickname', `<h1>Profile nickname</h1><p>Nicknames are locked by default.</p>
<p><button id="unlock" type="button">Unlock</button></p>
<p><label>Nickname <input id="nickname" type="text" disabled></label></p>
<p id="status">Locked</p><p id="saved">Nickname on file: none</p>
<script>window.__bench = { nickname: null };
(function () { var input = document.getElementById('nickname'), open = false, busy = false;
  document.getElementById('unlock').addEventListener('click', function () { if (open || busy) return; busy = true;
    document.getElementById('status').textContent = 'Unlocking';
    setTimeout(function () { open = true; input.value = ''; input.disabled = false; document.getElementById('status').textContent = 'Ready'; }, 3500); });
  input.addEventListener('input', function () { if (!open) return; window.__bench.nickname = input.value;
    document.getElementById('saved').textContent = 'Nickname on file: ' + (input.value || 'none'); });
})();</script>`) : page('Profile nickname', `<h1>Profile nickname</h1>
<p><label>Nickname <input id="nick" type="text"></label></p>
<p id="status">Editable</p><p id="saved">Nickname on file: none</p>
<script>window.__bench = { nickname: null };
document.getElementById('nick').addEventListener('input', function (e) { window.__bench.nickname = e.target.value;
  document.getElementById('saved').textContent = 'Nickname on file: ' + (e.target.value || 'none'); });</script>`),

  // iframe-quirk: the controls live in a cross-origin frame, out of reach of locator tools.
  checkout: (v, frameOrigin) => page('Checkout', `<h1>Checkout</h1><p>Order total: $48.00</p>` + (v === 1
    ? `<iframe id="promo-frame" title="Promo code" src="${frameOrigin}/widget" width="460" height="110"></iframe>`
    : `<p><label>Promo code <input id="promo-code" type="text"></label> <button id="apply-promo" type="button">Apply</button></p>`) + `
<p id="status">No promo applied</p>
<script>window.__bench = { applied: null };
function applied(code) { window.__bench.applied = code; document.getElementById('status').textContent = 'Promo applied: ' + code; }
window.addEventListener('message', function (e) { if (e.origin === ${JSON.stringify(frameOrigin)} && e.data && e.data.type === 'promo') applied(String(e.data.code)); });
var inline = document.getElementById('apply-promo');
if (inline) inline.addEventListener('click', function () { applied(document.getElementById('promo-code').value); });</script>`),
  widget: () => page('Promo code', `<p><label>Promo code <input id="promo" type="text"></label> <button id="apply" type="button">Apply</button></p>
<script>document.getElementById('apply').addEventListener('click', function () { parent.postMessage({ type: 'promo', code: document.getElementById('promo').value }, '*'); });</script>`),

  // anti-pattern: the link opens a new tab, which a synthetic click cannot do.
  invoices: v => page('Invoices', `<h1>Invoices</h1><table><tr><th>Month</th><th>Status</th><th>Details</th></tr>` + Object.keys(INVOICES).map(month => {
    const label = month[0].toUpperCase() + month.slice(1);
    return v === 1
      ? `<tr><td>${label}</td><td>Paid</td><td><a id="view-${month}" href="/invoices/${month}" target="_blank" rel="noopener">View</a></td></tr>`
      : `<tr><td>${label}</td><td>Paid</td><td><a id="open-${month}" href="/billing/${month}">View</a></td></tr>`;
  }).join('') + '</table>'),
  invoice: month => page('Invoice', `<h1>${month[0].toUpperCase() + month.slice(1)} invoice</h1><p>Total: ${INVOICES[month]}</p><p>Status: Paid</p><p><a href="/invoices">All invoices</a></p>`),
  invoiceMoved: () => page('Not found', '<h1>Invoice not found</h1><p>Invoice pages have moved. Open one from the list.</p><p><a href="/invoices">All invoices</a></p>'),

  // tool-tip: typing a name is not a selection; an option has to be clicked to commit.
  ticket: v => page('Ticket 12', `<h1>Ticket 12: Printer offline</h1><p>Assignee: <strong id="current">Unassigned</strong></p>` + (v === 1
    ? `<p><label>Assign to <input id="assignee" type="text" role="combobox" aria-controls="people" autocomplete="off" placeholder="Search people"></label></p><ul id="people" role="listbox"></ul>`
    : `<p><label>Assign to <select id="owner"><option value="">Unassigned</option><option>Dana Reyes</option><option>Dan Abbot</option><option>Priya Nair</option><option>Omar Haddad</option></select></label></p>`) + `
<script>window.__bench = { assignee: null };
function commit(name) { window.__bench.assignee = name || null; document.getElementById('current').textContent = name || 'Unassigned'; }
(function () { var people = ['Dana Reyes', 'Dan Abbot', 'Priya Nair', 'Omar Haddad'];
  var owner = document.getElementById('owner'); if (owner) { owner.addEventListener('change', function () { commit(owner.value); }); return; }
  var input = document.getElementById('assignee'), list = document.getElementById('people'), timer = null;
  input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { list.innerHTML = '';
    var q = input.value.trim().toLowerCase(); if (!q) return;
    people.filter(function (p) { return p.toLowerCase().indexOf(q) === 0 || q.indexOf(p.toLowerCase()) === 0; }).forEach(function (p) {
      var li = document.createElement('li'); li.setAttribute('role', 'option'); li.tabIndex = -1; li.textContent = p;
      li.addEventListener('click', function () { input.value = p; list.innerHTML = ''; commit(p); }); list.appendChild(li); }); }, 300); });
})();</script>`),

  // selector: two same-label buttons, and the first one in the page is the wrong one.
  settings: v => {
    const notes = v === 1
      ? `<section id="notes"><h2>Scratch notes</h2><p><textarea id="note" rows="2" cols="40"></textarea></p><p><button id="note-save" type="button">Save</button></p></section>`
      : `<section id="notes"><h2>Scratch notes</h2><p><textarea id="note" rows="2" cols="40"></textarea></p><p><button id="save-notes" type="button">Save</button></p></section>`;
    const profile = v === 1
      ? `<section id="profile"><h2>Profile</h2><p><label>Display name <input id="display-name" type="text" value="Sam"></label></p><p><button id="profile-save" type="button">Save</button></p></section>`
      : `<section id="profile"><h2>Profile</h2><p><label>Display name <input id="name" type="text" value="Sam"></label></p><p><button id="save-profile" type="button">Save</button></p></section>`;
    return page('Settings', `<h1>Settings</h1>${v === 1 ? notes + profile : profile + notes}
<p id="status">No changes saved</p><p id="onfile">Name on file: Sam</p>
<script>window.__bench = { profile: null, noteSaves: 0 };
document.querySelector('#notes button').addEventListener('click', function () { window.__bench.noteSaves += 1; document.getElementById('status').textContent = 'Saved.'; });
document.querySelector('#profile button').addEventListener('click', function () { var value = document.querySelector('#profile input').value;
  window.__bench.profile = value; document.getElementById('status').textContent = 'Saved.'; document.getElementById('onfile').textContent = 'Name on file: ' + value; });</script>`);
  },

  // workflow: the submit is ignored until a prerequisite in a collapsed section is met.
  workspaces: v => page('New workspace', `<h1>New workspace</h1><p><label>Name <input id="ws-name" type="text"></label></p>` + (v === 1
    ? `<p><button id="advanced-toggle" type="button" aria-expanded="false">Advanced</button></p><div id="advanced" hidden><label><input type="checkbox" id="confirm"> I am the billing owner</label></div>` : '') + `
<p><button id="create" type="button">Create</button></p><p id="status">Not created</p><p id="hint"></p>
<script>window.__bench = { created: null };
var toggle = document.getElementById('advanced-toggle');
if (toggle) toggle.addEventListener('click', function () { var box = document.getElementById('advanced'); box.hidden = !box.hidden; toggle.setAttribute('aria-expanded', String(!box.hidden)); });
document.getElementById('create').addEventListener('click', function () { var name = document.getElementById('ws-name').value.trim(), confirm = document.getElementById('confirm');
  if (!name) { document.getElementById('hint').textContent = 'Name is required'; return; }
  if (confirm && !confirm.checked) { document.getElementById('hint').textContent = 'Confirm the billing owner under Advanced first'; return; }
  window.__bench.created = name; document.getElementById('hint').textContent = ''; document.getElementById('status').textContent = 'Created: ' + name; });</script>`),

  // url-pattern: the list pages slowly, but every record has a direct address.
  orders: () => page('Orders', `<h1>Orders</h1><p id="count"></p>
<table id="orders"><thead><tr><th>Order</th><th>Customer</th><th>Status</th></tr></thead><tbody></tbody></table>
<p><button id="more" type="button">Load more</button></p>
<script>(function () { var all = ${JSON.stringify(ORDERS)}, shown = 0, body = document.querySelector('#orders tbody');
  function add() { all.slice(shown, shown + 5).forEach(function (o) { var tr = document.createElement('tr');
      [o.id, o.customer, o.status].forEach(function (text) { var td = document.createElement('td'); td.textContent = text; tr.appendChild(td); }); body.appendChild(tr); });
    shown = Math.min(all.length, shown + 5); document.getElementById('count').textContent = 'Showing ' + shown + ' of ' + all.length + ' orders';
    if (shown >= all.length) document.getElementById('more').hidden = true; }
  add(); document.getElementById('more').addEventListener('click', function () { setTimeout(add, 400); });
})();</script>`),
  order: o => page(`Order ${o.id}`, `<h1>Order ${o.id}</h1><p>Customer: ${o.customer}</p><p>Status: ${o.status}</p><p><a href="/orders">All orders</a></p>`),
  orderMoved: () => page('Not found', '<h1>Order not found</h1><p>Order pages have moved. Find the order in the list.</p><p><a href="/orders">All orders</a></p>'),

  // workflow: the first button looks final, but a second confirmation appears later.
  waitlist: v => page('Waitlist', `<h1>Join the waitlist</h1><p><label>Team name <input id="team" type="text"></label></p>` + (v === 1
    ? `<p><button id="continue" type="button">Continue</button></p><p id="status">Not joined</p><div id="step2" hidden><p>Review: team <b id="review"></b></p><p><button id="confirm-join" type="button">Confirm</button></p></div>`
    : `<p><button id="join" type="button">Continue</button></p><p id="status">Not joined</p>`) + `
<script>window.__bench = { joined: null };
function joined(team) { window.__bench.joined = team; document.getElementById('status').textContent = 'Joined: ' + team; }
var single = document.getElementById('join');
if (single) single.addEventListener('click', function () { var team = document.getElementById('team').value.trim(); if (team) joined(team); });
var first = document.getElementById('continue');
if (first) { first.addEventListener('click', function () { var team = document.getElementById('team').value.trim(); if (!team) return;
    document.getElementById('status').textContent = 'Almost done';
    setTimeout(function () { document.getElementById('review').textContent = team; document.getElementById('step2').hidden = false; }, 900); });
  document.getElementById('confirm-join').addEventListener('click', function () { joined(document.getElementById('team').value.trim()); }); }</script>`),

  // controls: nothing to learn.
  city: () => page('Preferences', `<h1>Preferences</h1><p><label>City <input id="city" type="text"></label></p><p><label><input type="checkbox" id="news"> Send me updates</label></p>
<script>window.__bench = { city: '', news: false };
document.getElementById('city').addEventListener('input', function (e) { window.__bench.city = e.target.value; });
document.getElementById('news').addEventListener('change', function (e) { window.__bench.news = e.target.checked; });</script>`),
  rates: () => page('Plans', '<h1>Plans</h1><table id="plans"><tr><th>Plan</th><th>Monthly price</th><th>Seats</th></tr><tr><td>Starter</td><td>$9</td><td>3</td></tr><tr><td>Team</td><td>$24</td><td>10</td></tr><tr><td>Enterprise</td><td>$79</td><td>50</td></tr></table>'),
  notFound: () => page('Not found', '<h1>Not found</h1><p><a href="/">Workbench</a></p>'),
};

// Path -> task id whose variant it reads.
const TASK_OF = { nickname: 'nickname', checkout: 'promo', invoices: 'invoice', billing: 'invoice', ticket: 'assign', settings: 'settings', workspaces: 'workspace', orders: 'order', order: 'order', waitlist: 'waitlist' };

export async function startFixture({ host, port = 18931, framePort = 18932, controlToken = randomBytes(16).toString('hex') } = {}) {
  if (!host) throw new Error('host is required (a LAN address, not localhost)');
  const origin = `http://${host}:${port}`, frameOrigin = `http://${host}:${framePort}`;
  const variants = new Map();
  const variant = task => variants.get(task) ?? 1;
  const send = (res, status, html) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html); };

  const main = createServer((req, res) => {
    const url = new URL(req.url, origin);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === '__control') {
      if (req.headers['x-bench-token'] !== controlToken) { res.writeHead(403).end(); return; }
      if (req.method === 'POST') {
        const task = url.searchParams.get('task'), v = Number(url.searchParams.get('v'));
        if (!task || (v !== 1 && v !== 2)) { res.writeHead(400).end(); return; }
        variants.set(task, v);
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Object.fromEntries(variants)));
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const [head, id] = parts;
    const v = variant(TASK_OF[head]);
    if (parts.length === 0) return send(res, 200, pages.index());
    if (parts.length === 1 && head === 'checkout') return send(res, 200, pages.checkout(v, frameOrigin));
    if (parts.length === 1 && head !== 'widget' && head !== 'order' && head !== 'billing' && typeof pages[head] === 'function' && head in TASK_OF) return send(res, 200, pages[head](v));
    if (parts.length === 1 && (head === 'city' || head === 'rates')) return send(res, 200, pages[head]());
    if (parts.length === 2 && head === 'invoices' && INVOICES[id]) return v === 1 ? send(res, 200, pages.invoice(id)) : send(res, 404, pages.invoiceMoved());
    if (parts.length === 2 && head === 'billing' && INVOICES[id] && v === 2) return send(res, 200, pages.invoice(id));
    const order = parts.length === 2 ? ORDERS.find(o => o.id === id) : null;
    if (order && head === 'orders') return v === 1 ? send(res, 200, pages.order(order)) : send(res, 404, pages.orderMoved());
    if (order && head === 'order' && v === 2) return send(res, 200, pages.order(order));
    return send(res, 404, pages.notFound());
  });
  const frame = createServer((req, res) => new URL(req.url, frameOrigin).pathname === '/widget' ? send(res, 200, pages.widget()) : send(res, 404, pages.notFound()));
  const listen = (server, p) => new Promise((accept, reject) => { server.once('error', reject); server.listen(p, host, accept); });
  await listen(main, port); await listen(frame, framePort);
  return { origin, frameOrigin, controlToken, close: () => Promise.all([main, frame].map(s => new Promise(done => s.close(done)))) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const fixture = await startFixture({ host: arg('host'), port: Number(arg('port') || 18931), framePort: Number(arg('frame-port') || 18932), controlToken: process.env.QUIRK_CONTROL_TOKEN });
  console.log(JSON.stringify({ origin: fixture.origin, frameOrigin: fixture.frameOrigin, controlToken: process.env.QUIRK_CONTROL_TOKEN ? '(from env)' : fixture.controlToken }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => fixture.close().then(() => process.exit(0)));
}
