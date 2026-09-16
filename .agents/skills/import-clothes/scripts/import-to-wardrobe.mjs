#!/usr/bin/env node
// Kept at the skill's established path; shared implementation supports both stores.
import { importClothesMain } from '../../../../scripts/import-reviewed-clothes.mjs';
importClothesMain().catch(error => { console.error(error.message); process.exitCode = 1; });
