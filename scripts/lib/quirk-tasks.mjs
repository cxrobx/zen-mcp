// Task definitions for the nav-memory quirk eval. Goals are variant-neutral: the
// same sentence is given on the original page and on the changed one.
//
// warmup  a scripted FIRST VISIT on variant 1 through the real tool handlers, naive
//         attempt included, which is what the real distiller then reads.
// check   the live state proof that promotes a distilled selector note in the
//         "shipped" arm (null = the page offers nothing the gate can prove).
// ideal   the hand-written note for the ceiling arm, within the 140-byte summary cap.

const step = (tool, args = {}, expect = 'ok') => ({ tool, args, expect });
const byUid = (tool, label, args = {}) => ({ tool, args, expect: 'ok', uidLabel: label });

export const TASKS = [
  {
    id: 'nickname', group: 'quirk', quirk: 'timing', path: '/nickname',
    goal: 'Set the profile nickname to benchmark.',
    oracle: 'return !!window.__bench && window.__bench.nickname === "benchmark";',
    warmup: [step('interactive_elements'), step('click', { selector: '#unlock' }), step('fill', { selector: '#nickname', value: 'benchmark' }, 'any'),
      step('wait_for', { condition: 'text', text: 'Ready', timeout: 9000 }), step('fill', { selector: '#nickname', value: 'benchmark' })],
    check: { selector: '#nickname', state: 'value', value: 'benchmark' },
    ideal: { kind: 'timing', summary: 'After clicking #unlock the field stays disabled ~4s: wait_for text Ready before fill, or the fill is silently discarded.' },
  },
  {
    id: 'promo', group: 'quirk', quirk: 'iframe-quirk', path: '/checkout',
    goal: 'Apply the promo code SAVE10 to the order.',
    oracle: 'return !!window.__bench && window.__bench.applied === "SAVE10";',
    warmup: [step('take_snapshot'), step('fill', { selector: '#promo', value: 'SAVE10', timeoutMs: 1500 }, 'error'), step('interactive_elements'),
      byUid('fill_by_uid', / input .*frame=/, { value: 'SAVE10' }), byUid('click_by_uid', / button "Apply" frame=/), step('wait_for', { condition: 'text', text: 'Promo applied', timeout: 5000 })],
    check: null,
    ideal: { kind: 'iframe-quirk', summary: 'Promo field and Apply sit in a cross-origin iframe: locator fill/click fail; use UIDs from interactive_elements.' },
  },
  {
    id: 'invoice', group: 'quirk', quirk: 'anti-pattern', path: '/invoices',
    goal: 'Return the total of the March invoice.',
    answer: /(?<![\d,.])4,?310(?:\.00)?(?![\d,])/,
    warmup: [step('interactive_elements'), step('click', { selector: '#view-march' }, 'any'), step('get_page_text'),
      step('navigate_page', { path: '/invoices/march' }), step('get_page_text')],
    check: null,
    ideal: { kind: 'anti-pattern', summary: 'View links open a new tab and are popup-blocked; navigate_page straight to /invoices/march for the March invoice.' },
  },
  {
    id: 'assign', group: 'quirk', quirk: 'tool-tip', path: '/ticket',
    goal: 'Assign the ticket to Dana Reyes.',
    oracle: 'return !!window.__bench && window.__bench.assignee === "Dana Reyes";',
    warmup: [step('interactive_elements'), step('fill', { selector: '#assignee', value: 'Dana Reyes' }), step('get_page_text'),
      step('wait_for', { condition: 'selector_visible', selector: '#people li', timeout: 5000 }), step('click', { selector: '#people li' })],
    check: { selector: '#people li', state: 'count', count: 0 },
    ideal: { kind: 'tool-tip', summary: 'Filling #assignee does not assign. After fill, wait for the #people option list and click the matching option to commit.' },
  },
  {
    id: 'settings', group: 'quirk', quirk: 'selector', path: '/settings',
    goal: 'Change the display name to Avery and save the profile.',
    oracle: 'return !!window.__bench && window.__bench.profile === "Avery";',
    side: 'return window.__bench ? window.__bench.noteSaves : null;',
    warmup: [step('interactive_elements'), step('fill', { selector: '#display-name', value: 'Avery' }), step('click', { selector: 'text:Save' }), step('get_page_text'),
      step('click', { selector: '#profile-save' }), step('get_page_text')],
    check: { selector: '#display-name', state: 'value', value: 'Avery' },
    ideal: { kind: 'selector', summary: 'Two Save buttons: the first saves scratch notes. Use #profile-save, then confirm Name on file changed.' },
  },
  {
    id: 'workspace', group: 'quirk', quirk: 'workflow', path: '/workspaces',
    goal: 'Create a workspace named Orbit.',
    oracle: 'return !!window.__bench && window.__bench.created === "Orbit";',
    warmup: [step('interactive_elements'), step('fill', { selector: '#ws-name', value: 'Orbit' }), step('click', { selector: '#create' }), step('get_page_text'),
      step('click', { selector: '#advanced-toggle' }), step('click', { selector: '#confirm' }), step('click', { selector: '#create' })],
    check: { selector: '#confirm', state: 'checked', present: true },
    ideal: { kind: 'workflow', summary: 'Create is ignored until #confirm (inside the collapsed Advanced section) is ticked: open Advanced, tick it, then Create.' },
  },
  {
    id: 'order', group: 'quirk', quirk: 'url-pattern', path: '/orders',
    goal: 'Return the status of order ZX-417.',
    answer: /\brefunded\b/i,
    warmup: [step('get_page_text'),
      ...[10, 15].flatMap(count => [step('click', { selector: '#more' }), step('wait_for', { condition: 'selector_count', selector: '#orders tbody tr', count, op: '>=', timeout: 5000 })]),
      step('get_page_text', { selector: '#orders' })],
    check: { selector: '#orders tbody tr', state: 'count', count: 15 },
    ideal: { kind: 'url-pattern', summary: 'Order detail pages live at /orders/<order id>; navigate there directly rather than paging the list with Load more.' },
  },
  {
    id: 'waitlist', group: 'quirk', quirk: 'workflow', path: '/waitlist',
    goal: 'Join the waitlist with the team name Nimbus.',
    oracle: 'return !!window.__bench && window.__bench.joined === "Nimbus";',
    warmup: [step('interactive_elements'), step('fill', { selector: '#team', value: 'Nimbus' }), step('click', { selector: '#continue' }), step('get_page_text'),
      step('wait_for', { condition: 'selector_visible', selector: '#confirm-join', timeout: 5000 }), step('click', { selector: '#confirm-join' })],
    check: { selector: '#team', state: 'value', value: 'Nimbus' },
    ideal: { kind: 'workflow', summary: 'Continue is not the last step: about 1s later #confirm-join appears. Click it and check status reads Joined.' },
  },
  {
    id: 'city', group: 'control', quirk: null, path: '/city',
    goal: 'Enter Lisbon as the city and turn on updates.',
    oracle: 'return !!window.__bench && window.__bench.city === "Lisbon" && window.__bench.news === true;',
    warmup: [step('interactive_elements'), step('fill', { selector: '#city', value: 'Lisbon' }), step('click', { selector: '#news' })],
    check: { selector: '#news', state: 'checked', present: true },
    ideal: { kind: 'selector', summary: 'Plain form: #city takes fill and #news takes click; both apply immediately, no save step.' },
  },
  {
    id: 'rates', group: 'control', quirk: null, path: '/rates',
    goal: 'Return the monthly price of the Team plan.',
    answer: /(?<![\d.])24(?![\d.])/,
    warmup: [step('get_page_text')],
    check: null,
    ideal: { kind: 'tool-tip', summary: 'Prices are in a plain table; get_page_text returns every plan and price in one call.' },
  },
];

// variant 1 = the page the notes were learned on; variant 2 = the page after it changed.
export const ARMS = {
  off: { variant: 1, memory: false, bank: null },
  shipped: { variant: 1, memory: true, bank: 'shipped' },
  ungated: { variant: 1, memory: true, bank: 'ungated' },
  ideal: { variant: 1, memory: true, bank: 'ideal' },
  'off-changed': { variant: 2, memory: false, bank: null },
  'stale-ungated': { variant: 2, memory: true, bank: 'ungated' },
  'stale-ideal': { variant: 2, memory: true, bank: 'ideal' },
};

// Control pages have no changed variant, so they run the four original-page arms only.
export const armsFor = task => Object.keys(ARMS).filter(name => task.group === 'quirk' || ARMS[name].variant === 1);
