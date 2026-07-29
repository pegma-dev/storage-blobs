# Contributing to Storage Blobs

Thank you for helping improve Storage Blobs.

## Before opening an issue

- Search existing issues for related work.
- Use GitHub's private vulnerability reporting flow for security concerns.
- Describe the storage behaviour you need and which backends must honour it,
  not only the TypeScript shape you would like.
- If a proposal needs the port to own authorization, rate limiting, malware
  scanning, or client-facing provider URLs as the default path, say so
  explicitly — those are changes the design cannot absorb without rewriting
  the boundaries.

## Local development

Storage Blobs requires Node.js 22 or newer.

```sh
npm ci
npm run check
npm test
npm run format:check
```

## Pull requests

Keep pull requests focused. Include:

- the problem being solved;
- the intended port or adapter behaviour;
- conformance cases for any behaviour a component may rely on;
- adapter tests against a real backend when touching an adapter;
- documentation for public API changes.

A behaviour that is not in the conformance suite is not part of the contract.

## License

By contributing, you agree that your contributions will be licensed under the
MIT License.
