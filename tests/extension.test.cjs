'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const resources = path.join(__dirname, '../MyJDownloader Extension/Resources');
const read = file => fs.readFileSync(path.join(resources, file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function page(t) {
  const listeners = [], captures = [], timers = new Set();
  let reply, ctx;
  const window = {
    addEventListener(type, listener) { if (type === 'message') listeners.push(listener); },
    postMessage(data) { queueMicrotask(() => listeners.forEach(fn => fn({source: window, data}))); },
    fetch() { return Promise.resolve(new Response('network')); },
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
  const document = {
    createElement() { return {textContent: '', remove() {}}; },
    head: {appendChild(script) { vm.runInContext(script.textContent, ctx); }},
    addEventListener() {}
  };
  ctx = vm.createContext({window, document, location: {href: 'https://example.org/helper.html', pathname: '/helper.html'},
    navigator: {}, screen: {}, URL, URLSearchParams, FormData, Request, Response, Event, console: {info() {}, error() {}},
    setTimeout(fn, delay) { const id = setTimeout(fn, delay); timers.add(id); return id; },
    clearTimeout(id) { clearTimeout(id); timers.delete(id); },
    chrome: {runtime: {sendMessage(message, callback) { captures.push(message); reply = callback; }}}
  });
  t.after(() => timers.forEach(clearTimeout));
  vm.runInContext(read('contentscripts/cnlCaptureContentscript.js'), ctx);
  return {window, captures, reply(value) { assert.ok(reply); reply(value); }};
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
