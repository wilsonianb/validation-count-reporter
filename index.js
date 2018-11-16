'use strict';

const codec = require('ripple-binary-codec');
const addressCodec = require('ripple-address-codec');
const request = require('request-promise');
const WebSocket = require('ws');
const smoment = require('moment');
const Promise = require('bluebird');
var resolve = Promise.promisify(require("dns").resolve4);
var Slack = require('slack-node');
const names = require('./validator-names.json');

const webhookUri = process.env['WEBHOOK_URI']

var slack = new Slack();
slack.setWebhook(webhookUri);

const connections = {};
const validations = {};
const ledgers = {};

let validators = {}
let manifestKeys = {}

const valListUrl = process.env['ALTNET'] ? 'https://vl.altnet.rippletest.net' : 'https://vl.ripple.com'
let valListSeq = 0

const WS_PORT = '51233';

var trouble = false
var goodLedgerTime = smoment()
var badLedger = 0

function messageSlack (message) {
  slack.webhook({
    text: message
  }, function(err, response) {
    if (err)
      console.log(err)
  });
}

function getName (pubkey) {
  return names[pubkey] ? names[pubkey] : pubkey
}

function saveManifest(manifest) {
  const pubkey = manifest.master_key
  if (validators[pubkey] &&
      validators[pubkey].seq < manifest.seq) {
    delete manifestKeys[validators[pubkey].signing_key]

    validators[pubkey].signing_key = manifest.signing_key
    validators[pubkey].seq = manifest.seq
    manifestKeys[validators[pubkey].signing_key] = pubkey
    messageSlack('<!channel> :scroll: new manifest for: `' + getName(pubkey) +'`: #' + validators[pubkey].seq + ', `'+ validators[pubkey].signing_key +'`')
  }
}

function saveValidation(validation) {
  validation.public_key = manifestKeys[validation.validation_public_key]

  if (!validation.public_key ||
      !validators[validation.public_key])
    return

  const key = [
    validation.ledger_hash,
    validation.public_key
  ].join('|');

  // already encountered
  if (validations[key]) {
    validations[key].timestamp = validation.timestamp // update timestamp
    return
  }

  validations[key] = validation; // cache

  if (!ledgers[validation.ledger_hash]) {
    ledgers[validation.ledger_hash] = {
      timestamp: validation.timestamp,
      index: validation.ledger_index,
      full: [],
      partial: []
    }
  }

  if (validation.full) {
    ledgers[validation.ledger_hash].full.push(validation.public_key)
    if (ledgers[validation.ledger_hash].full.length == Object.keys(validators).length &&
        !trouble) {
      reportLedger(validation.ledger_hash)
    }
  } else {
    ledgers[validation.ledger_hash].partial.push(validation.public_key)
  }
}

function reportLedger(hash) {
  let message = '`' + ledgers[hash].index + '` `' + hash + '` received ' + ledgers[hash].full.length +
    '/' + Object.keys(validators).length + ' full validations'

  if (ledgers[hash].full.length === Object.keys(validators).length &&
      !ledgers[hash].partial.length) {
    message = ':heavy_check_mark: ' + message
    trouble = false
    goodLedgerTime = smoment()
  } else {
    console.log(ledgers[hash])
    message = ':x: ' + message

    if (!trouble &&
      (goodLedgerTime < ledgers[hash].timestamp ||
        ledgers[hash].index-badLedger > Object.keys(ledgers).length)) {
      messageSlack('<!channel> :fire:')
      console.log('@channel')
      trouble = true
    }

    if (badLedger < ledgers[hash].index)
      badLedger = ledgers[hash].index

    const details = {}

    if (ledgers[hash].partial.length) {
      details.partial = ledgers[hash].partial.map(pubkey => getName(pubkey))
    }

    if ((ledgers[hash].full.length + ledgers[hash].partial.length) > Object.keys(validators).length/2) {
      details.missing = []

      for (const pubkey of Object.keys(validators)) {
        if (ledgers[hash].full.indexOf(pubkey) === -1 &&
            ledgers[hash].partial.indexOf(pubkey) === -1)
          details.missing.push(getName(pubkey))
      }

      if (!details.missing.length) {
        delete details.missing
      }
    } else {
      if (ledgers[hash].full.length) {
        details.full = ledgers[hash].full.map(pubkey => getName(pubkey))
      }
    }
    message += '\n```' + JSON.stringify(details, null, 2) + '```'
  }

  messageSlack(message)
  delete ledgers[hash]
}

function subscribe(ip) {

  // Skip addresses that are already connected
  if (connections[ip]) {
    return;
  }

  const ws = new WebSocket(ip);
  connections[ip] = ws;

  ws.on('error', function(error) {
    if (this.url && connections[this.url]) {
      connections[this.url].close();
      delete connections[this.url];
    }
  });

  ws.on('close', function(error) {
    if (this.url && connections[this.url]) {
      delete connections[this.url];
    }
  });

  ws.on('open', function() {
    if (this.url &&
        connections[this.url]) {
      connections[this.url].send(JSON.stringify({
        id: 1,
        command: 'subscribe',
        streams: [
          'validations'
        ]
      }));

      connections[this.url].send(JSON.stringify({
        id: 2,
        command: 'subscribe',
        streams: [
          'manifests'
        ]
      }));
    }
  });

  ws.on('message', function(dataString) {
    const data = JSON.parse(dataString);

    if (data.type === 'validationReceived') {
      const validation = {
        validation_public_key: data.validation_public_key,
        ledger_hash: data.ledger_hash,
        ledger_index: data.ledger_index,
        full: data.full,
        timestamp: smoment()
      };

      saveValidation(validation);
    } else if (data.type === 'manifestReceived') {
      saveManifest(data);
    } else if (data.error === 'unknownStream') {
      delete connections[this.url];
      console.log(data.error);
    }
  });
}

function subscribeToRippleds() {

  // Subscribe to validation websocket subscriptions from rippleds
  resolve(process.env['ALTNET'] ? 'r.altnet.rippletest.net' : 'r.ripple.com').then(ips => {
    for (const ip of ips) {
      subscribe('ws://' + ip + ':' + WS_PORT);
    }
  })
}

function purge() {
  const now = smoment();

  for (let hash in ledgers) {
    if (smoment().diff(ledgers[hash].timestamp) > 10000) {
      reportLedger(hash)
    }
  }

  for (let key in validations) {
    if (smoment().diff(validations[key].timestamp) > 300000) {
      delete validations[key];
    }
  }
}

function parseManifest (data) {
  let buff = Buffer.from(data, 'base64');
  let manhex = buff.toString('hex').toUpperCase();
  return codec.decode(manhex)
}

function toBytes(hex) {
  return Buffer.from(hex, 'hex').toJSON().data;
}

function hextoBase58 (hex) {
  return addressCodec.encodeNodePublic(toBytes(hex))
}

function remove(array, element) {
  const index = array.indexOf(element);

  if (index !== -1) {
    array.splice(index, 1);
  }
}

function setName (pubkey) {
  request.get({
    url: 'https://data.ripple.com/v2/network/validators/' + pubkey,
    json: true
  }).then(data => {
    if (data.domain) {
      if (data.domain === 'ripple.com')
        names[pubkey] = 'RIPPLE' + pubkey
      else
        names[pubkey] = data.domain
    }
  })
}

function getUNL () {
  request.get({
    url: valListUrl,
    json: true
  }).then(data => {
    let buff = Buffer.from(data.blob, 'base64');
    const valList = JSON.parse(buff.toString('ascii'))

    if (valList.sequence <= valListSeq) {
      return
    }

    valListSeq = valList.sequence

    let oldValidators = Object.keys(validators)

    const startup = !oldValidators.length
    for (const validator of valList.validators) {
      const pubkey = hextoBase58(validator.validation_public_key)
      remove(oldValidators, pubkey)

      const manifest = parseManifest(validator.manifest)

      if (!validators[pubkey] || validators[pubkey].seq < manifest.Sequence) {
        if (validators[pubkey]) {
          delete manifestKeys[validators[pubkey].signing_key]
        } else {
          validators[pubkey] = {}
          if (getName(pubkey)===pubkey)
            setName(pubkey)
          if (!startup)
            messageSlack('<!channel> :tada: new validator added to published list: `' + getName(pubkey) + '` (`' + pubkey + '`)')
        }
        validators[pubkey].signing_key = hextoBase58(manifest.SigningPubKey)
        validators[pubkey].seq = manifest.Sequence
        manifestKeys[validators[pubkey].signing_key] = pubkey
        if (!startup)
          messageSlack('<!channel> :scroll: new manifest for: `' + getName(pubkey) +'`: #' + validators[pubkey].seq + ', `'+ validators[pubkey].signing_key +'`')
      }
    }
    for (const validator of oldValidators) {
      messageSlack('<!channel> validator removed from published list: `' + getName(validator) + '` (`' + validator + '`)')
      delete validators[validator]
    }
    console.log(validators)
    console.log(manifestKeys)
  });
}

function refreshSubscriptions() {
  console.log('refreshing')
  getUNL()
  subscribeToRippleds()
}

refreshSubscriptions()

// refresh connectionsevery minute
setInterval(refreshSubscriptions, 60 * 1000);

// flush stale validations from cache every 5 seconds
setInterval(purge, 5000);
