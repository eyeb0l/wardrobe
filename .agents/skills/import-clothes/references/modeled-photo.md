# Modeled garment photos

Read this when modeled photos are part of the requested import. Cutout-only delivery does not need this workflow or an identity reference.

For each reviewed cutout, use Imagegen with the resolved identity image first and the exact garment PNG second. Save a horizontal 3:2 PNG as `$WORK/modeled/SLUG.png` and set `modeledFile` to `SLUG.png` in the manifest.

Use this brief, adapting the setting to the item:

```text
Create a professional horizontal 3:2 editorial fashion photograph of the person in Image 1 wearing the exact clothing item from Image 2.

Preserve the person's recognizable face, hair, age, build, skin texture, and body proportions. Preserve the featured garment precisely: color, material, fit, construction, pattern, graphics, logos, text, proportions, closure, and distinctive details. Do not redesign, simplify, replace, or reinterpret it.

Use understated neutral supporting clothes that complete the outfit without covering or competing with the featured item. Invisible basics such as socks are allowed where needed. You may add simple unpatterned black or brown tights, sheer or opaque, when seasonally or stylistically appropriate, even if they are not represented as a wardrobe item. Beyond these basics and the necessary neutral supporting clothes, do not invent other visible garments or accessories. Keep the full featured item and every important detail visible. Use a natural pose with arms and accessories away from it.

Place the person in a tasteful real-world setting with warm professional natural light, realistic shadows, authentic skin and fabric texture, and restrained editorial color grading. Leave environmental breathing room for flexible cropping.

Avoid hidden garment details, invented closures, fake text or logos, extra statement pieces, crossed arms, bags or scarves covering the item, cropped item extremities, extra people, text overlays, watermarks, product-mockup styling, or synthetic AI polish.
```

This styling allowance applies only to modeled photos; do not add tights to source-derived cutouts or create wardrobe records for styling additions.

Vary understated settings across a batch while keeping the identity and art direction cohesive. Compare each photo against both references for identity, garment fidelity, visibility, anatomy, and 3:2 framing. Regenerate identity drift, garment redesign, blocked details, anatomy failures, or incorrect framing. Mark the item `accepted` only when its cutout and modeled photo both pass.
