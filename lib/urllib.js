/**!
 * urllib - lib/urllib.js
 *
 * Copyright(c) 2011 - 2014 fengmk2 and other contributors.
 * MIT Licensed
 *
 * Authors:
 *   fengmk2 <fengmk2@gmail.com> (http://fengmk2.github.com)
 */

"use strict";

/**
 * Module dependencies.
 */

var debug = require('debug')('urllib');
var crypto = require('crypto');
var http = require('http');
var https = require('https');
var urlutil = require('url');
var qs = require('querystring');
var path = require('path');
var fs = require('fs');
var zlib = require('zlib');
var ua = require('default-user-agent');
var digestAuthHeader = require('digest-header');

var pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../', 'package.json')));

var USER_AGENT = exports.USER_AGENT = ua('node-urllib', pkg.version);
var TIME_OUT = exports.TIME_OUT = 60000; // 60 seconds

// change Agent.maxSockets to 1000
exports.agent = new http.Agent();
exports.agent.maxSockets = 1000;

exports.httpsAgent = new https.Agent();
exports.httpsAgent.maxSockets = 1000;

/**
 * The default request timeout(in milliseconds).
 * @type {Number}
 * @const
 */
exports.TIMEOUT = 5000;

var REQUEST_ID = 0;

/**
 * Handle all http request, both http and https support well.
 *
 * @example
 *
 * // GET http://httptest.cnodejs.net
 * urllib.request('http://httptest.cnodejs.net/test/get', function(err, data, res) {});
 * // POST http://httptest.cnodejs.net
 * var args = { type: 'post', data: { foo: 'bar' } };
 * urllib.request('http://httptest.cnodejs.net/test/post', args, function(err, data, res) {});
 *
 * @param {String|Object} url
 * @param {Object} [args], optional
 *   - {Object} [data]: request data, will auto be query stringify.
 *   - {String|Buffer} [content]: optional, if set content, `data` will ignore.
 *   - {ReadStream} [stream]: read stream to sent.
 *   - {WriteStream} [writeStream]: writable stream to save response data.
 *       If you use this, callback's data should be null.
 *       We will just `pipe(ws, {end: true})`.
 *   - {String} [method]: optional, could be GET | POST | DELETE | PUT, default is GET
 *   - {String} [dataType]: optional, `text` or `json`, default is text
 *   - {Object} [headers]: optional, request headers
 *   - {Number} [timeout]: request timeout(in milliseconds), default is `exports.TIMEOUT`
 *   - {Agent} [agent]: optional, http agent. Set `false` if you does not use agent.
 *   - {Agent} [httpsAgent]: optional, https agent. Set `false` if you does not use agent.
 *   - {String} [auth]: Basic authentication i.e. 'user:password' to compute an Authorization header.
 *   - {String} [digestAuth]: Digest authentication i.e. 'user:password' to compute an Authorization header.
 *   - {String|Buffer|Array} [ca]: An array of strings or Buffers of trusted certificates.
 *       If this is omitted several well known "root" CAs will be used, like VeriSign.
 *       These are used to authorize connections.
 *       Notes: This is necessary only if the server uses the self-signed certificate
 *   - {Boolean} [rejectUnauthorized]: If true, the server certificate is verified against the list of supplied CAs.
 *       An 'error' event is emitted if verification fails. Default: true.
 *   - {String|Buffer} [pfx]: A string or Buffer containing the private key,
 *       certificate and CA certs of the server in PFX or PKCS12 format.
 *   - {String|Buffer} [key]: A string or Buffer containing the private key of the client in PEM format.
 *       Notes: This is necessary only if using the client certificate authentication
 *   - {String|Buffer} [cert]: A string or Buffer containing the certificate key of the client in PEM format.
 *       Notes: This is necessary only if using the client certificate authentication
 *   - {String} [passphrase]: A string of passphrase for the private key or pfx.
 *   - {Boolean} [followRedirect]: Follow HTTP 3xx responses as redirects. defaults to false.
 *   - {Number} [maxRedirects]: The maximum number of redirects to follow, defaults to 10.
 *   - {Function(options)} [beforeRequest]: Before request hook, you can change every thing here.
 *   - {Boolean} [gzip]: Accept gzip response content and auto decode it, default is `false`.
 * @param {Function} [callback], callback(error, data, res)
 * @return {HttpRequest} req object.
 * @api public
 */
exports.request = function (url, args, callback) {
  if (typeof args === 'function') {
    callback = args;
    args = null;
  }

  args = args || {};

  if (!callback) {
    callback = function () {};
  }

  args.timeout = args.timeout || exports.TIMEOUT;
  args.maxRedirects = args.maxRedirects || 10;
  var parsedUrl = typeof url === 'string' ? urlutil.parse(url) : url;

  var method = (args.type || args.method || parsedUrl.method || 'GET').toUpperCase();
  var port = parsedUrl.port || 80;
  var httplib = http;
  var agent = args.agent || exports.agent;

  if (parsedUrl.protocol === 'https:') {
    httplib = https;
    agent = args.httpsAgent || exports.httpsAgent;
    if (args.httpsAgent === false) {
      agent = false;
    }
    if (!parsedUrl.port) {
      port = 443;
    }
  }

  if (args.agent === false) {
    agent = false;
  }

  var options = {
    host: parsedUrl.hostname || parsedUrl.host || 'localhost',
    path: parsedUrl.path || '/',
    method: method,
    port: port,
    agent: agent,
    headers: args.headers || {}
  };

  var sslNames = ['ca', 'pfx', 'key', 'cert', 'passphrase'];
  for (var i = 0; i < sslNames.length; i++) {
    var name = sslNames[i];
    if (args[name]) {
      options[name] = args[name];
    }
  }

  if (args.rejectUnauthorized !== undefined) {
    options.rejectUnauthorized = args.rejectUnauthorized;
  }

  var auth = args.auth || parsedUrl.auth;
  if (auth) {
    options.auth = auth;
  }

  var body = args.content || args.data;
  var isReadAction = method === 'GET' || method === 'HEAD';
  if (!args.content) {
    if (body && !(typeof body === 'string' || Buffer.isBuffer(body))) {
      if (isReadAction) {
        // read: GET, HEAD, use query string
        body = qs.stringify(body);
      } else {
        // auto add application/x-www-form-urlencoded when using urlencode form request
        if (!options.headers['Content-Type'] && !options.headers['content-type']) {
          options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }

        var contentType = options.headers['Content-Type'] || options.headers['content-type'];
        if (contentType === 'application/json') {
          body = JSON.stringify(body);
        } else {
          // 'application/x-www-form-urlencoded'
          body = qs.stringify(body);
        }
      }
    }
  }

  // if it's a GET or HEAD request, data should be sent as query string
  if (isReadAction && body) {
    options.path += (parsedUrl.query ? '&' : '?') + body;
    body = null;
  }

  if (body) {
    var length = body.length;
    if (!Buffer.isBuffer(body)) {
      length = Buffer.byteLength(body);
    }
    options.headers['Content-Length'] = length;
  }

  if (args.dataType === 'json') {
    options.headers.Accept = 'application/json';
  }

  if (typeof args.beforeRequest === 'function') {
    // you can use this hook to change every thing.
    args.beforeRequest(options);
  }
  var timer = null;
  var __err = null;
  var connnected = false; // socket connected or not
  var done = function (err, data, res) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!callback) {
      console.warn('[urllib:warn] [%s] [worker:%s] %s %s callback twice!!!',
        Date(), process.pid, options.method, url);
      // TODO: why will be done twice?
      return;
    }
    var cb = callback;
    callback = null;
    if (err) {
      var statusCode = res && res.statusCode || -1;
      var headers = JSON.stringify(res && res.headers || {});
      err.message += ', ' + options.method + ' ' + url + ' ' + statusCode
        + '\nheaders: ' + headers;
      if (res) {
        err.res = {
          statusCode: res.statusCode,
          headers: res.headers,
          aborted: res.aborted,
        };
      }
      err.data = data;
    }

    // handle digest auth
    if (res && res.statusCode === 401 && res.headers['www-authenticate']
        && (!args.headers || !args.headers.Authorization) && args.digestAuth) {
      var authenticate = res.headers['www-authenticate'];
      if (authenticate.indexOf('Digest ') >= 0) {
        debug('Request#%d %s: got degist auth header WWW-Authenticate: %s', reqId, url, authenticate);
        args.headers = args.headers || {};
        args.headers.Authorization = digestAuthHeader(options.method, options.path, authenticate, args.digestAuth);
        debug('Request#%d %s: auth with digest header: %s', reqId, url, args.headers.Authorization);
        if (res.headers['set-cookie']) {
          args.headers.Cookie = res.headers['set-cookie'].join(';');
        }
        return exports.request(url, args, cb);
      }
    }

    cb(err, data, res);
  };

  var handleRedirect = function (res) {
    var err = null;
    if ((res.statusCode === 302 || res.statusCode === 301) && args.followRedirect) {  // handle redirect
      args._followRedirectCount = (args._followRedirectCount || 0) + 1;
      if (!res.headers.location) {
        err = new Error('Got statusCode ' + res.statusCode + ' but cannot resolve next location from headers');
        err.name = 'FollowRedirectError';
      } else if (args._followRedirectCount > args.maxRedirects) {
        err = new Error('Exceeded maxRedirects. Probably stuck in a redirect loop ' + url);
        err.name = 'MaxRedirectError';
      } else {
        var _url = urlutil.resolve(url, res.headers.location);
        debug('Request#%d %s: `redirected` from %s to %s', reqId, options.path, url, _url);
        // should pass done instead of callback
        exports.request(_url, args, done);
        return {
          redirect: true,
          error: null
        };
      }
    }
    return {
      redirect: false,
      error: err
    };
  };

  // set user-agent
  if (!options.headers['User-Agent'] && !options.headers['user-agent']) {
    options.headers['User-Agent'] = USER_AGENT;
  }

  var enableGzip = args.gzip === true;
  if (enableGzip) {
    var acceptEncoding = options.headers['Accept-Encoding'] || options.headers['accept-encoding'];
    if (acceptEncoding) {
      enableGzip = false; // user want to handle response content decode themself
    } else {
      options.headers['Accept-Encoding'] = 'gzip';
    }
  }

  var decodeContent = function (res, body, cb) {
    var encoding = res.headers['content-encoding'];
    if (body.length === 0 || !enableGzip) {
      return cb(null, body, encoding);
    }

    if (!encoding || encoding.toLowerCase() !== 'gzip') {
      return cb(null, body, encoding);
    }

    debug('gunzip %d length body', body.length);
    zlib.gunzip(body, cb);
  };

  var writeStream = args.writeStream;

  var reqId = ++REQUEST_ID;
  debug('Request#%d %s %s with headers %j', reqId, method, url, options.headers);
  var req = httplib.request(options, function (res) {
    connnected = true;
    debug('Request#%d %s `req response` event emit: status %d, headers: %j',
      reqId, url, res.statusCode, res.headers);

    if (writeStream) {
      // If there's a writable stream to recieve the response data, just pipe the
      // response stream to that writable stream and call the callback when it has
      // finished writing.
      //
      // NOTE that when the response stream `res` emits an 'end' event it just
      // means that it has finished piping data to another stream. In the
      // meanwhile that writable stream may still writing data to the disk until
      // it emits a 'close' event.
      //
      // That means that we should not apply callback until the 'close' of the
      // writable stream is emited.
      //
      // See also:
      // - https://github.com/TBEDP/urllib/commit/959ac3365821e0e028c231a5e8efca6af410eabb
      // - http://nodejs.org/api/stream.html#stream_event_end
      // - http://nodejs.org/api/stream.html#stream_event_close_1
      var result = handleRedirect(res);
      if (result.redirect) {
        return;
      }
      if (result.error) {
        // end ths stream first
        writeStream.end();
        return done(result.error, null, res);
      }
      writeStream.on('close', done.bind(null, null, null, res));
      return res.pipe(writeStream);
    }

    // Otherwise, just concat those buffers.
    //
    // NOTE that the `chunk` is not a String but a Buffer. It means that if
    // you simply concat two chunk with `+` you're actually converting both
    // Buffers into Strings before concating them. It'll cause problems when
    // dealing with multi-byte characters.
    //
    // The solution is to store each chunk in an array and concat them with
    // 'buffer-concat' when all chunks is recieved.
    //
    // See also:
    // http://cnodejs.org/topic/4faf65852e8fb5bc65113403

    var chunks = [];
    var size = 0;

    res.on('data', function (chunk) {
      debug('Request#%d %s: `res data` event emit, size %d', reqId, url, chunk.length);
      size += chunk.length;
      chunks.push(chunk);
    });

    res.on('close', function () {
      debug('Request#%d %s: `res close` event emit, total size %d', reqId, url, size);
    });

    res.on('error', function () {
      debug('Request#%d %s: `res error` event emit, total size %d', reqId, url, size);
    });

    res.on('aborted', function () {
      res.aborted = true;
      debug('Request#%d %s: `res aborted` event emit, total size %d', reqId, url, size);
    });

    res.on('end', function () {
      var body = Buffer.concat(chunks, size);
      debug('Request#%d %s: `res end` event emit, total size %d, _dumped: %s', reqId, url, size, res._dumped);

      if (__err && connnected) {
        // req.abort() after `res data` event emit.
        return done(__err, body, res);
      }

      var result = handleRedirect(res);
      if (result.error) {
        return done(result.error, body, res);
      }
      if (result.redirect) {
        return;
      }

      decodeContent(res, body, function (err, data, encoding) {
        if (err) {
          return done(err, body, res);
        }

        // if body not decode, dont touch it
        if (!encoding && args.dataType === 'json') {
          try {
            data = size > 0 ? JSON.parse(data) : null;
          } catch (e) {
            if (e.name === 'SyntaxError') {
              e.name = 'JSONResponseFormatError';
            }
            err = e;
          }
        }

        if (res.aborted) {
          err = new Error('Remote socket was terminated before `response.end()` was called');
          err.name = 'RemoteSocketClosedError';
        }

        done(err, data, res);
      });
    });
  });

  var abortRequest = function () {
    // it wont case error event when req haven't been assigned a socket yet.
    if (!req.socket) {
      done(__err);
    }
    req.abort();
  };

  var timeout = args.timeout;

  timer = setTimeout(function () {
    timer = null;
    var msg = 'Request#' + reqId + ' timeout for ' + timeout + 'ms';
    __err = new Error(msg);
    __err.name = connnected ? 'ResponseTimeoutError' : 'ConnectionTimeoutError';
    debug('Request#%d %s %s: %s, connected: %s', reqId, options.path, __err.name, msg, connnected);
    abortRequest();
  }, timeout);

  req.on('close', function () {
    debug('Request#%d %s: `req close` event emit', reqId, options.path);
  });

  req.on('error', function (err) {
    if (!__err && err.name === 'Error') {
      err.name = 'RequestError';
    }
    err = __err || err;
    debug('Request#%d %s `req error` event emit, %s: %s', reqId, options.path, err.name, err.message);
    done(err);
  });

  if (writeStream) {
    writeStream.once('error', function (err) {
      __err = err;
      debug('Request#%d %s `writeStream error` event emit, %s: %s', reqId, options.path, err.name, err.message);
      abortRequest();
    });
  }

  if (args.stream) {
    args.stream.pipe(req);
    args.stream.once('error', function (err) {
      __err = err;
      debug('Request#%d %s `readStream error` event emit, %s: %s', reqId, options.path, err.name, err.message);
      abortRequest();
    });
  } else {
    req.end(body);
  }

  req.requestId = reqId;
  return req;
};
