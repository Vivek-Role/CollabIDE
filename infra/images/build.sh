#!/usr/bin/env bash
#
# Build the sandbox images — module 6.2.
#
# The tags MUST match LANGUAGES[*].image in packages/shared/src/languages.ts.
# Nothing type-checks an image name against a Docker daemon, so a mismatch here
# is a runtime failure in the runner rather than a build error.
#
# The build context is this directory: it holds only these three files and
# neither Dockerfile has a COPY, so nothing from the repo can reach a layer.
set -euo pipefail

cd "$(dirname "$0")"

docker build -f python.Dockerfile -t collab-sandbox-python:1 .
docker build -f node.Dockerfile   -t collab-sandbox-node:1   .

echo
echo "built: collab-sandbox-python:1"
echo "built: collab-sandbox-node:1"
