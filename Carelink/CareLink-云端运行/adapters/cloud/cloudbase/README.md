# Cloud sandbox adapter · offline preflight

This package currently provides only an Alibaba OSS implementation of the frozen
`MediaStore` port. It uses Node built-ins and an injectable `fetch` transport.

It is not wired into the API, does not issue direct-upload credentials, and has
not contacted a cloud sandbox. The real Track 1B gate remains closed until Max
authorizes a disposable isolated sandbox and its credentials are injected from
an approved local secret store.

The adapter expects a regional HTTPS endpoint such as
`https://oss-cn-example.aliyuncs.com`, a bucket name, and scoped RAM credentials.
Objects are private, conditional PUT uses `x-oss-forbid-overwrite`, and the
canonical MediaStore `etag` is the persisted SHA-256 metadata rather than the
provider's MD5 ETag.
