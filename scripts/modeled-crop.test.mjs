import assert from "node:assert/strict";
import test from "node:test";
import { modeledCrop } from "../src/modeled-crop.mjs";
import { modeledDimensionError } from "../shared/modeled-upload.mjs";

test("near-3:2 example dimensions produce exact accepted crops without upscaling", () => {
  for (const [width, height, expected] of [[1263, 841, [1260, 840]], [1264, 848, [1263, 842]], [1536, 1024, [1536, 1024]]]) {
    const crop = modeledCrop(width, height, "garment");
    assert.deepEqual([crop.outputWidth, crop.outputHeight], expected);
    assert.equal(modeledDimensionError(crop.outputWidth, crop.outputHeight, "garment"), null);
    assert.ok(crop.outputWidth <= crop.width && crop.outputHeight <= crop.height);
    assert.ok(Math.abs(crop.width / crop.height - 1.5) < 1e-10);
    assert.ok(crop.x >= 0 && crop.x + crop.width <= width);
    assert.ok(crop.y >= 0 && crop.y + crop.height <= height);
  }
});

test("pan and zoom keep portrait, landscape and square crops within the source and minimum resolution", () => {
  for (const [width, height] of [[800, 1600], [4000, 600], [1600, 1600], [768, 512], [8000, 8000]]) {
    for (const kind of ["garment", "outfit"]) {
      for (const framing of [{}, { zoom: 2, x: 0, y: 1 }, { zoom: 999, x: -100, y: 50 }]) {
        const crop = modeledCrop(width, height, kind, framing);
        assert.equal(modeledDimensionError(crop.outputWidth, crop.outputHeight, kind), null);
        assert.ok(crop.x >= 0 && crop.x + crop.width <= width + 1e-8);
        assert.ok(crop.y >= 0 && crop.y + crop.height <= height + 1e-8);
        assert.ok(crop.outputWidth <= crop.width + 1e-8 && crop.outputHeight <= crop.height + 1e-8);
        assert.ok(Math.max(crop.outputWidth, crop.outputHeight) <= 2400);
      }
    }
  }
  const left = modeledCrop(1600, 1000, "outfit", { zoom: 1.5, x: 0 });
  const right = modeledCrop(1600, 1000, "outfit", { zoom: 1.5, x: 1 });
  assert.equal(left.x, 0);
  assert.equal(right.x + right.width, 1600);
});

test("too-small and oversized inputs fail before a crop can be uploaded", () => {
  for (const [width, height, kind] of [[767, 512, "garment"], [768, 511, "garment"], [511, 512, "outfit"], [0, 0, "outfit"], [8001, 8001, "outfit"]]) {
    assert.throws(() => modeledCrop(width, height, kind), /too small|valid photo/);
  }
});
