# HTTP transport

[http](http/README.md) owns local authorization, routing, body limits, response
serialization and HTTP error translation. It consumes shared contracts from
`domain.schemas`. External clients use the same HTTP API as the browser.

Add behavior to an application owner first. Keep decoding, validation and calling
public operations in the transport. Preserve the URLs documented in
[API.md](../../API.md); [llms.txt](../../llms.txt) is the client integration guide.

Test authorization, validation, dispatch and failure preservation through the real
handlers. Use socket integration tests when changing network behavior.
