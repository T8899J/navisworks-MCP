# Bridge protocol

The MCP server and the in-process Navisworks plug-in communicate over a
Windows named pipe whose ACL grants access only to the current user.

## Discovery

Each plug-in process writes its own discovery file:

```text
%LOCALAPPDATA%\NavisworksCodexMcp\endpoints\{ProcessId}.json
```

The document contains the pipe name, protocol version, process ID, plug-in
version, and host version. It does not contain credentials. Access to the pipe
is restricted by Windows to the current user.

The process that creates an endpoint owns its lifetime and removes only that file
when it unloads. Desktop clients are readers: a pipe timeout marks the instance
disconnected but must not delete the file. The Electron client scans every numeric
JSON file in `endpoints`; when none exists it may read the legacy `endpoint.json`
as a transition fallback.

The repository and currently installed legacy `navisworks-mcp.mjs` bundle still
read only `endpoint.json`. They are not discovery-compatible with a rebuilt plug-in
that writes only the per-process directory; fixing that bundle is a separate task.

Document identity is returned by `navisworks_status`, not stored in the endpoint file:

```json
{
  "connected": true,
  "hasDocument": true,
  "bridgeSessionId": "plugin-lifetime-guid",
  "documentInstanceId": "active-document-guid",
  "documentTitle": "Model.nwf",
  "documentFileName": "D:\\Models\\Model.nwf"
}
```

`bridgeSessionId` is stable for one plug-in load. `documentInstanceId` changes when the
active document changes, closes, or the same path is reopened. Clients must invalidate
document-bound item IDs, viewpoint references and pending modifications when either identity changes.

## Framing

Each message is:

1. a four-byte unsigned little-endian payload length;
2. one UTF-8 JSON payload.

The maximum payload is 1 MiB. One pipe connection may carry one or more
request/response pairs, although the MCP server currently uses one request per
connection.

If a response payload itself exceeds the limit (for example a very large
property query), the server does not drop the connection: it serializes a
small failure frame with error code `RESPONSE_TOO_LARGE` instead, so the
client always receives an answer for its request id. If even the degraded
frame cannot be written (the pipe is already broken), the connection is
closed and reported as `BRIDGE_RESPONSE_WRITE_FAILED`.

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
