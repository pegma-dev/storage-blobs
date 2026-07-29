# Security Policy

## Supported versions

This project is in early `0.x` development. Security fixes land on the latest
published release of packages in this repository only. Nothing is published
yet; treat source on `main` as unstable.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository.
Do not open a public issue for suspected vulnerabilities.

When reporting, include:

- the package and version (or commit);
- a clear description of the issue;
- steps to reproduce; and
- the impact if object bytes, storage credentials, or capability material
  could be exposed, confused, or overwritten across principals.

## Threat model notes for reporters

`BlobStore` is intended for **trusted server-side** use after the host has
authorized the caller. It is not an access-control system. Attachment content
must be treated as hostile by consuming applications even when stored through
this port.
