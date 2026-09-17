# Checkout quote service

`createQuoteService()` returns an isolated service used by one checkout session.
Calling `quote()` with the same input may reuse the immutable result object.
Every result must otherwise reflect all of the input values supplied for that
call.

Run `npm test` after changing the service.
