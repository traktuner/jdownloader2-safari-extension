'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const resources = path.join(__dirname, '../MyJDownloader Extension/Resources');
const read = file => fs.readFileSync(path.join(resources, file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function page(t, options = {}) {
  const listeners = [], contentListeners = [], submits = [], captures = [], timers = new Set(), nodes = {};
  let reply, pageContext, rootChanged;
  function postMessage(data) {
    queueMicrotask(() => {
      listeners.forEach(fn => fn({source: window, data}));
      contentListeners.forEach(fn => fn({source: contentWindow, data}));
    });
  }
  class Form {
    constructor(action, fields) { this.action = action; this.fields = fields; }
    submit() { throw new Error('Captured form must not navigate'); }
  }
  function DOMFormData(form) {
    const data = new FormData();
    for (const [key, value] of form ? form.fields : []) data.append(key, value);
    return data;
  }
  Object.defineProperty(DOMFormData, Symbol.hasInstance, {value: value => value instanceof FormData});
  const window = {
    addEventListener(type, listener) { if (type === 'message') listeners.push(listener); },
    postMessage,
    HTMLFormElement: Form,
    fetch() { return Promise.resolve(new Response('network')); },
    navigator: {sendBeacon() { throw new Error('Captured beacon must not reach the network'); }},
    XMLHttpRequest: class extends EventTarget {
      open() {}
      send() { throw new Error('Captured request must not reach the network'); }
      dispatchEvent(event) {
        super.dispatchEvent(event);
        if (typeof this['on' + event.type] === 'function') this['on' + event.type](event);
        return true;
      }
    }
  };
  const contentWindow = {
    addEventListener(type, listener) { if (type === 'message') contentListeners.push(listener); },
    postMessage
  };
  const head = {appendChild(script) {
    if (!options.blockInline) vm.runInContext(script.textContent, pageContext);
  }};
  const document = {
    baseURI: options.baseURI || 'https://example.org/helper.html',
    createElement(tag) { return {tag, textContent: '', style: {}, setAttribute() {}, remove() {}}; },
    head: options.noRoot ? null : head,
    body: {appendChild(node) { nodes[node.id] = node; node.isConnected = true; }},
    getElementById(id) { return nodes[id]; },
    addEventListener(type, listener) { if (type === 'submit') submits.push(listener); },
    open() { throw new Error('Sending a form must preserve the original page'); }
  };
  const globals = {document, location: {href: 'https://example.org/helper.html', pathname: '/helper.html'},
    screen: {}, URL, URLSearchParams, FormData: DOMFormData, Request, Response, Blob, Event, console: {info() {}, error() {}},
    MutationObserver: class {
      constructor(callback) { rootChanged = callback; }
      observe() {}
      disconnect() { rootChanged = null; }
    },
    setTimeout(fn, delay) { const id = setTimeout(fn, delay); timers.add(id); return id; },
    clearTimeout(id) { clearTimeout(id); timers.delete(id); }
  };
  pageContext = vm.createContext({...globals, window, HTMLFormElement: Form, navigator: window.navigator});
  const contentContext = vm.createContext({...globals, window: contentWindow, navigator: {},
    chrome: {runtime: {sendMessage(message, callback) { captures.push(message); reply = callback; }}}
  });
  t.after(() => timers.forEach(clearTimeout));
  vm.runInContext(read('contentscripts/cnlCaptureContentscript.js'), contentContext);
  return {window, captures, nodes,
    attachRoot() { document.head = head; assert.ok(rootChanged); rootChanged(); },
    reply(value) { assert.ok(reply); reply(value); },
    submit(form, submitter) {
      const event = {target: form, submitter, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }};
      for (const listener of submits) { listener(event); if (event.stopped) break; }
      return event;
    }
  };
}

test('CnL only intercepts exact loopback endpoints', async t => {
  const p = page(t);
  for (const url of ['https://example.org/127.0.0.1:9666/flash/add',
    'http://localhost:9667/flash/add', 'http://localhost:9666/flash/additional',
    'http://user:password@localhost:9666/flash/add']) {
    assert.equal(await (await p.window.fetch(url, {body: 'urls=x'})).text(), 'network');
  }
  assert.equal(p.captures.length, 0);
});

test('page hook waits for the document root instead of losing early injection', async t => {
  const p = page(t, {noRoot: true});
  p.attachRoot();
  const response = p.window.fetch('http://localhost:9666/flash/add', {body: 'urls=https://example.org/a'});
  await tick();
  assert.equal(p.captures.length, 1);
  p.reply({data: {}});
  assert.equal(await (await response).text(), 'success');
});

test('fetch(Request) forwards the body and waits for the actual device acknowledgment', async t => {
  const p = page(t);
  let settled = false;
  const response = p.window.fetch(new Request('http://localhost:9666/flash/add',
    {method: 'POST', body: 'urls=https%3A%2F%2Fexample.org%2Ffile&package=My+Package'}));
  response.then(() => { settled = true; });
  for (let i = 0; i < 20 && !p.captures.length; i++) await tick();
  assert.equal(settled, false);
  assert.equal(p.captures[0].data.formData.urls, 'https://example.org/file');
  assert.equal(p.captures[0].data.formData.package, 'My Package');
  p.reply({data: {deviceName: 'Test'}});
  assert.equal(await (await response).text(), 'success');
});

test('multipart Request preserves CnL fields', async t => {
  const p = page(t), body = new FormData();
  body.set('crypted', 'encrypted'); body.set('jk', 'function f(){}');
  const response = p.window.fetch(new Request('http://127.0.0.1:9666/flash/addcrypted2', {method: 'POST', body}));
  for (let i = 0; i < 20 && !p.captures.length; i++) await tick();
  assert.equal(p.captures[0].data.formData.crypted, 'encrypted');
  p.reply({error: 'NO_CONNECTED_DEVICE'});
  const result = await response;
  assert.equal(result.status, 502);
  assert.match(await result.text(), /NO_CONNECTED_DEVICE/);
});

test('XHR dispatches one completion after acknowledgment', async t => {
  const p = page(t), xhr = new p.window.XMLHttpRequest();
  let changes = 0;
  xhr.open('POST', 'http://localhost:9666/flash/addcrypted2');
  xhr.onreadystatechange = () => changes++;
  xhr.send('crypted=x&jk=y');
  await tick();
  assert.equal(changes, 0);
  p.reply({data: {}});
  await tick();
  assert.equal(changes, 1);
  assert.equal(xhr.status, 200);
  assert.equal(xhr.responseText, 'success');
});

test('GET payloads and document base URLs reach the exact CnL endpoint', async t => {
  const p = page(t, {baseURI: 'http://localhost:9666/'});
  const response = p.window.fetch('/flash/add?urls=https%3A%2F%2Fexample.org%2Fa&package=Query',
    {body: new URLSearchParams({package: 'Body'})});
  await tick();
  assert.equal(p.captures[0].data.formData.urls, 'https://example.org/a');
  assert.equal(p.captures[0].data.formData.package, 'Body');
  assert.match(p.captures[0].data.cnlUrl, /^http:\/\/localhost:9666\/flash\/add/);
  p.reply({data: {}});
  assert.equal(await (await response).text(), 'success');
});

test('JDownloader discovery via fetch and XHR does not send a download', async t => {
  const p = page(t);
  const response = await p.window.fetch('http://127.0.0.1:9666/jdcheck.js?cache=1');
  assert.match(await response.text(), /jdownloader = true/);
  const xhr = new p.window.XMLHttpRequest();
  xhr.open('GET', 'http://localhost:9666/jdcheck.js');
  xhr.send();
  await tick();
  assert.equal(xhr.status, 200);
  assert.match(xhr.responseText, /jdownloader = true/);
  assert.equal(p.captures.length, 0);
  assert.equal(await (await p.window.fetch('https://example.org/jdcheck.js')).text(), 'network');
});

test('Blob bodies work for sendBeacon without optimistic device success', async t => {
  const p = page(t);
  assert.equal(p.window.navigator.sendBeacon('http://localhost:9666/flash/addcrypted2',
    new Blob(['crypted=encrypted&jk=key'], {type: 'application/x-www-form-urlencoded'})), true);
  for (let i = 0; i < 20 && !p.captures.length; i++) await tick();
  assert.equal(p.captures[0].data.formData.crypted, 'encrypted');
  p.reply({error: 'NO_CONNECTED_DEVICE'});
  await tick();
});

test('isolated form fallback survives blocked inline script and honors submitter action', async t => {
  const p = page(t, {blockInline: true});
  const form = new p.window.HTMLFormElement('https://example.org/original', [['crypted', 'x'], ['jk', 'y']]);
  const submitter = {hasAttribute(name) { return name === 'formaction'; },
    formAction: 'http://localhost:9666/flash/addcrypted2', name: 'source', value: 'https://example.org/container'};
  const event = p.submit(form, submitter);
  assert.equal(event.defaultPrevented, true);
  await tick();
  assert.equal(p.captures.length, 1);
  assert.equal(p.captures[0].data.formData.source, 'https://example.org/container');
  p.reply({data: {}});
  await tick();
  assert.equal(Object.values(p.nodes)[0].textContent, 'An JDownloader gesendet.');
});

test('programmatic form.submit is captured once while ordinary forms are untouched', async t => {
  const p = page(t);
  const unrelated = new p.window.HTMLFormElement('https://example.org/post', [['urls', 'x']]);
  assert.equal(p.submit(unrelated).defaultPrevented, false);
  const form = new p.window.HTMLFormElement('http://localhost:9666/flash/add', [['urls', 'https://example.org/a']]);
  form.submit();
  await tick();
  assert.equal(p.captures.length, 1);
  p.reply({data: {}});
  await tick();
  assert.equal(Object.values(p.nodes)[0].textContent, 'An JDownloader gesendet.');
});

test('background validates both plain and encrypted CnL payloads', () => {
  const source = read('scripts/controllers/BackgroundController.js');
  const start = source.indexOf('      function validCnlCapture(data)');
  const end = source.indexOf("      // Safari Click'n'Load:", start);
  const ctx = vm.createContext({URL});
  vm.runInContext(source.slice(start, end), ctx);
  const valid = ctx.validCnlCapture;
  assert.equal(valid({cnlUrl: 'http://localhost:9666/flash/add', formData: {urls: 'https://example.org/file'}}), true);
  assert.equal(valid({cnlUrl: 'http://localhost:9666/flash/addcrypted2', formData: {crypted: 'x', jk: 'y'}}), true);
  assert.equal(valid({cnlUrl: 'https://evil.org/127.0.0.1:9666/flash/add', formData: {urls: 'x'}}), false);
  assert.equal(valid({cnlUrl: 'http://localhost:9666/flash/add', formData: JSON.parse('{"__proto__":"x","urls":"x"}')}), false);
});

test('login draft is private to login pages and expires without reopening the popup', () => {
  const source = read('scripts/controllers/BackgroundController.js');
  const start = source.indexOf('      var loginDraft = null;');
  const end = source.indexOf('      let urlRegexp', start);
  const listeners = {}, removals = [];
  let expire;
  const timeout = fn => { expire = fn; return 1; };
  timeout.cancel = () => {};
  const ctx = vm.createContext({$timeout: timeout, $scope: {state: {isConnected: false}},
    chrome: {storage: {local: {remove(key) { removals.push(key); }}},
      runtime: {getURL(file) { return 'safari-web-extension://test/' + file; }}},
    ExtensionMessagingService: {addListener(name, action, callback) { listeners[action] = callback; }}
  });
  vm.runInContext(source.slice(start, end), ctx);
  const sender = {url: 'safari-web-extension://test/popup.html'};
  let result;
  listeners.set({data: {email: 'test@example.org', password: 'test-only'}}, sender, value => { result = value; });
  listeners.get({}, {url: 'https://example.org'}, value => { result = value; });
  assert.equal(result.error, 'Invalid sender');
  listeners.get({}, sender, value => { result = value; });
  assert.equal(result.data.password, 'test-only');
  expire();
  listeners.get({}, sender, value => { result = value; });
  assert.equal(result.data, null);
  assert.deepEqual(removals, ['LOGIN_DRAFT']);
});

test('native bridge uses one constructor handshake and ignores results after logout', () => {
  const messages = [];
  function deferred() {
    const done = [], failed = [];
    return {done(fn) { done.push(fn); return this; }, fail(fn) { failed.push(fn); return this; },
      always(fn) { done.push(fn); failed.push(fn); return this; }, resolve(value) { done.forEach(fn => fn(value)); }};
  }
  let handshake, request, constructors = 0, disconnects = 0;
  function API(options, callback, key) {
    constructors++;
    assert.equal(options.email, 'test@example.org');
    assert.equal(key, 'myjd_webextension_safari');
    handshake = callback;
    this.listDevices = () => (request = deferred());
    this.disconnect = () => { disconnects++; return deferred(); };
  }
  const ctx = vm.createContext({window: {}, localStorage: {clear() {}}, $: {Deferred: deferred},
    require(modules, callback) { callback(API); },
    webkit: {messageHandlers: {jd: {postMessage(message) { messages.push(message); }}}}
  });
  vm.runInContext(read('vendor/jdclient.js'), ctx);
  ctx.window.bridge.connect('test@example.org', 'test-only', 1);
  handshake.resolve();
  assert.equal(constructors, 1);
  assert.equal(messages.at(-1).reqId, 1);
  ctx.window.bridge.listDevices(2);
  ctx.window.bridge.disconnect();
  request.resolve([{id: 'old-device'}]);
  assert.equal(disconnects, 1);
  assert.equal(messages.some(message => message.reqId === 2), false);
});

test('messaging wrapper keeps the response channel open for asynchronous handlers', () => {
  let listener, service, finish, response;
  const ctx = vm.createContext({
    angular: {module() { return {service(name, dependencies) {
      const Constructor = dependencies.at(-1);
      service = new Constructor(() => {});
    }}; }},
    chrome: {runtime: {onMessage: {addListener(fn) { listener = fn; }}}},
    $: {each(values, callback) { values.forEach((value, index) => callback(index, value)); }},
    console
  });
  vm.runInContext(read('scripts/services/ExtensionMessagingService.js'), ctx);
  service.addListener('test', 'pending', (request, sender, respond) => { finish = respond; });
  const keepOpen = listener({name: 'test', action: 'pending'}, {}, value => { response = value; });
  assert.equal(keepOpen, true);
  assert.equal(response, undefined);
  finish({data: 'accepted'});
  assert.deepEqual(response, {data: 'accepted'});
});
