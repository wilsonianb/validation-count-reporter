# XRP Ledger Validation Reporter

Reports XRP Ledger validation counts to Slack and/or outages to PagerDuty

## Usage

````
npm install
WEBHOOK_URI=<your-slack-webhook-uri> npm start
````

Or to monitor the [XRP Ledger Test Net](https://ripple.com/build/xrp-test-net/)

````
ALTNET=true WEBHOOK_URI=<your-slack-webhook-uri> npm start
````

To trigger/resolve [PagerDuty events](https://v2.developer.pagerduty.com/docs/send-an-event-events-api-v2) in the case of a validator outage, run with:
````
PAGERDUTY_KEY=<your-pagerduty-integration-key> PAGERDUTY_VALIDATOR=<validator-name-to-monitor> npm start
````

`PAGERDUTY_VALIDATOR` should correspond to a name (not key) in `validator-names.json`
