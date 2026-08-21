# Bridge protocol

The MCP server and the in-process Navisworks plug-in communicate over a
Windows named pipe whose ACL grants access only to the current user.

## Discovery

The plug-in writes:

```text
%LOCALAPPDATA%\NavisworksCodexMcp\endpoint.json
```

The document contains the pipe name, protocol version, process ID, plug-in
version, and host version. It does not contain credentials. Access to the pipe
is restricted by Windows to the current user.

## Framing

Each message is:

1. a four-byte unsigned little-endian payload length;
2. one UTF-8 JSON payload.

The maximum payload is 1 MiB. One pipe connection may carry one or more
request/response pairs, although the MCP server currently uses one request per
connection.

## Request

```json
{
  "Id": "b5f5...",
  "ProtocolVersion": 1,
  "Method": "navisworks_status",
  "Params": {}
}
```

## Response

```json
{
  "Id": "b5f5...",
  "Ok": true,
  "Result": {}
}
```

Errors use:

```json
{
  "Id": "b5f5...",
  "Ok": false,
  "Error": {
    "Code": "NO_DOCUMENT",
    "Message": "No Navisworks document is open."
  }
}
```
