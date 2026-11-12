// Readwise Reader for CrossPoint: settings card for the reader's web page.
// It stores the Readwise access token in config.json in the plugin folder,
// where the on-reader catalog (device.json) reads it as {token}.
(function () {
  'use strict';

  var AUTH_URL = 'https://readwise.io/api/v2/auth/';
  var COUNT_URL = 'https://readwise.io/api/v3/list/?category=epub&limit=1';
  var TOKEN_PAGE = 'https://readwise.io/access_token';

  // UTF-8 safe base64 for api.writeFile.
  function encodeBase64Utf8(value) {
    var bytes = new TextEncoder().encode(value);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  // Readwise tokens are opaque alphanumeric strings. Reject anything that
  // could not be one (whitespace inside, quotes, a pasted URL) before any
  // request is made or anything is written to the SD card.
  function normalizeToken(raw) {
    var token = String(raw == null ? '' : raw).trim();
    if (/^token\s+/i.test(token)) token = token.replace(/^token\s+/i, '');
    return /^[A-Za-z0-9_-]{16,128}$/.test(token) ? token : '';
  }

  function configPath(api) {
    var dir = api.dir || '/.crosspoint/plugins/' + api.name;
    return dir.replace(/\/+$/, '') + '/config.json';
  }

  function authHeaders(token) {
    return { Authorization: 'Token ' + token };
  }

  function describeStatus(status) {
    if (status === 401 || status === 403) return 'Readwise did not accept this token.';
    if (status === 429) return 'Readwise rate limit reached. Wait a minute and try again.';
    return 'Readwise answered HTTP ' + status + '.';
  }

  // Resolves to {ok: true} or {ok: false, message}. Readwise answers 204 for a
  // valid token.
  async function checkToken(api, token) {
    var res;
    try {
      res = await api.relay('GET', AUTH_URL, authHeaders(token), '');
    } catch (e) {
      return { ok: false, message: 'Could not reach Readwise: ' + ((e && e.message) || e) + '.' };
    }
    if (res.status === 204 || res.status === 200) return { ok: true };
    return { ok: false, message: describeStatus(res.status) };
  }

  // Number of EPUBs in the library, or null when it cannot be read.
  async function countEpubs(api, token) {
    try {
      var res = await api.relay('GET', COUNT_URL, authHeaders(token), '');
      if (res.status !== 200) return null;
      var count = JSON.parse(res.body).count;
      return typeof count === 'number' ? count : null;
    } catch (e) {
      return null;
    }
  }

  async function saveConfig(api, config) {
    await api.writeFile(configPath(api), encodeBase64Utf8(JSON.stringify(config) + '\n'));
  }

  async function readConfig(api, fetchFn) {
    try {
      var res = await fetchFn('/download?path=' + encodeURIComponent(configPath(api)));
      if (!res.ok) return {};
      var parsed = JSON.parse(await res.text());
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  // Validates and stores a token. Resolves to {ok, message}.
  async function connect(api, rawToken) {
    var token = normalizeToken(rawToken);
    if (!token) return { ok: false, message: 'That does not look like a Readwise access token.' };
    var check = await checkToken(api, token);
    if (!check.ok) return check;
    try {
      await saveConfig(api, { token: token });
    } catch (e) {
      return { ok: false, message: 'Could not save the token: ' + ((e && e.message) || e) + '.' };
    }
    return { ok: true, message: 'Connected.', token: token };
  }

  async function disconnect(api) {
    await saveConfig(api, {});
  }

  function connectedText(count) {
    var text = 'Connected.';
    if (typeof count === 'number') text += ' ' + count + (count === 1 ? ' EPUB' : ' EPUBs') + ' in your Reader library.';
    return text + ' On the reader, open Home > Plugins > Readwise Reader.';
  }

  async function render(container, api, fetchFn) {
    var id = function (name) { return 'rwr-' + name; };
    container.innerHTML =
      '<h2>Readwise Reader</h2>' +
      '<p id="rwr-status">Loading...</p>' +
      '<div id="rwr-signin" style="display:none">' +
        '<div class="setting-row"><span class="setting-name">Access token</span>' +
        '<span class="setting-control"><input type="password" id="rwr-token" autocomplete="off"></span></div>' +
        '<div class="setting-row"><button type="button" class="btn-small btn-add" id="rwr-connect">Connect</button></div>' +
        '<p style="color:#666">Get your token at <a href="' + TOKEN_PAGE + '" target="_blank" rel="noopener">readwise.io/access_token</a>, ' +
        'paste it above and tap Connect.</p>' +
      '</div>' +
      '<div id="rwr-connected" style="display:none">' +
        '<div class="setting-row"><button type="button" class="btn-small" id="rwr-disconnect">Disconnect</button></div>' +
      '</div>' +
      '<p style="color:#666">The token is saved unencrypted in config.json in this plugin\'s folder on the SD card. ' +
      'Disconnect removes it from the card; you can also revoke it on readwise.io.</p>';

    var el = function (name) { return container.querySelector('#' + id(name)); };
    var setStatus = function (text) { el('status').textContent = text; };
    var show = function (connected) {
      el('signin').style.display = connected ? 'none' : '';
      el('connected').style.display = connected ? '' : 'none';
    };

    var showConnected = async function (token) {
      show(true);
      setStatus('Connected.');
      setStatus(connectedText(await countEpubs(api, token)));
    };

    var config = await readConfig(api, fetchFn);
    if (normalizeToken(config.token)) {
      await showConnected(config.token);
    } else {
      show(false);
      setStatus('Not connected.');
    }

    el('connect').onclick = async function () {
      var button = el('connect');
      button.disabled = true;
      setStatus('Checking the token...');
      try {
        var result = await connect(api, el('token').value);
        if (result.ok) {
          el('token').value = '';
          await showConnected(result.token);
        } else {
          setStatus(result.message);
        }
      } finally {
        button.disabled = false;
      }
    };

    el('disconnect').onclick = async function () {
      try {
        await disconnect(api);
        show(false);
        setStatus('Disconnected. The token was removed from the SD card.');
      } catch (e) {
        setStatus('Could not disconnect: ' + ((e && e.message) || e) + '.');
      }
    };
  }

  if (typeof __readwiseReaderTest === 'object' && __readwiseReaderTest) {
    Object.assign(__readwiseReaderTest, {
      normalizeToken: normalizeToken,
      configPath: configPath,
      checkToken: checkToken,
      countEpubs: countEpubs,
      readConfig: readConfig,
      connect: connect,
      disconnect: disconnect,
      connectedText: connectedText,
      encodeBase64Utf8: encodeBase64Utf8,
      render: render,
    });
  }

  CrossPoint.registerPlugin(function (container, api) {
    return render(container, api, function (url) { return fetch(url); });
  });
})();
