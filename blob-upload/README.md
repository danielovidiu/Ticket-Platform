# blob-upload

One serverless function, in JavaScript, in a project whose backend is Python.

Vercel refuses a request body over about 4.5 MB before a function is reached, so a video
cannot be posted to the Python API at all — measured on this project, a 4 MB body is
answered `401` by the app and a 5 MB body is answered `413` by the edge. Relaying the file
in pieces does not help either: Blob's multipart upload wants 5 MiB parts, which is larger
than a request the platform will carry.

What is left is the browser sending the file to Blob directly, which needs a signed
client token. Vercel's **Python** SDK does not mint one — it exposes server-side
operations only — and the signing format is not documented well enough to reimplement.
The JavaScript SDK does, in `handleUpload`. That is the whole reason this directory
exists.

## Why a separate service

It was first placed at `frontend/api/blob-upload.js`, on the assumption that Vercel would
pick up an `api/` directory inside the frontend service. It did not: the deployment served
`index.html` for that path and answered `405` to a POST, because the SPA rewrite caught it
and nothing had been built as a function. Declaring it as its own service in `vercel.json`
— `root`, `entrypoint`, `runtime` — is the shape the config actually supports.

## The runtime value

`node`, not `nodejs24.x`. The published `vercel.json` schema describes `runtime` as
"e.g. nodejs24.x, python3.14", which is the vocabulary for a *lambda*, not for a service.
A service takes one of `node`, `python`, `go`, `rust`, `ruby`, `container` — the CLI
validates against that list and fails the build with "has invalid runtime" otherwise.
The schema accepts the wrong value happily, so this one cannot be caught by validating
the file; the first push of this service failed on exactly that.

It could be left out altogether — `.js` implies `node` — but naming it makes the service
say what it is beside the Python one above it.

## Auth

The function does not decide who may upload. It asks the deployment's own `/api/auth/me`
with the caller's cookie, so that rule has one implementation rather than two that can
drift apart.
