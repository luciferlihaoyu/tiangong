#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
if (args[0] !== "init") throw new Error("usage: tiangong artifact-volume init --volume-id <uuid> --generation <n>");
const value = (name) => args[args.indexOf(name) + 1];
const volumeId = value("--volume-id");
const generationId = Number(value("--generation"));
if (!volumeId || !Number.isSafeInteger(generationId) || generationId < 1) throw new Error("volume id and positive generation are required");
const modulePath = pathToFileURL(resolve("dist/artifact-volume-cli.js")).href;
const { ArtifactVolume } = await import(modulePath);
await new ArtifactVolume({ root: process.env.TIANGONG_ARTIFACT_ROOT ?? "/app/data/tiangong-artifacts", volumeId, generationId }).initialize();
