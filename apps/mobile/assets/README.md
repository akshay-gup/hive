# Hive bee

`bee-original.jpg` is Hive's mascot as generated: a stylized 3D render of a round, velvety bee on a plain white background (1024 × 576). It was made with an image generator for Hive on October 15, 2026 and is included under this repository's MIT license.

Generation prompt: “A high-end 3D render of a minimal, calm bee mascot for a productivity app, like a premium designer toy made of soft matte clay with a very fine velvet surface. A softly rounded, chubby, pebble-shaped body in muted honey-amber, with two smooth deep-cocoa-brown bands across the lower half. Small, simple, semi-translucent dusty pale-blue wings and two short, slender antennae with small round tips. A very minimal face: two small, solid dark bead eyes set wide apart with only a faint soft reflection, and a tiny, calm, simple curved smile, with generous empty space around the face and at most a very faint warm blush. Understated, grown-up and friendly, not childish. No arms, no legs, no feet, no stinger. Front view with a slight three-quarter turn, floating. Large soft studio lighting, smooth gentle gradients and soft ambient occlusion, with a fine soft-touch material that has no individual hairs, fibers, stitching or seams and no glossy plastic. Centered with a small margin on a plain flat white background, no cast shadow. One character only, no flowers, honey, props, text, logos or watermark.”

What the app uses is made from it:

- `bee.png` (512 px, transparent) is the original with the white background removed (flood-filled from the edges, with the fur-free edge pixels cleaned so no white halo shows on dark). The shared `Mascot` component shows it. Sky, sand and lilac discs behind it preserve the avatar color preference; the disc is placed on the bee's body, which sits at about 50% across and 56% down the image (`Mascot` in `src/ui.tsx`).
- `icon.png` (1024 px) is the app icon: the bee in a honeycomb cell on graphite, set as `icon` in `app.json` for native builds.
- `../public/apple-touch-icon.png` (180 px) is the same icon for iPhone home screens, and `../public/favicon.ico` (32 and 48 px) is the bee alone. The web export copies both to the site's root.

To change the bee, replace `bee-original.jpg`, cut out `bee.png` the same way (square, transparent, 512 px or more, with a little margin), and move the disc in `Mascot` if the body moves.

The earlier capybara mascot, generated with an image tool on September 16, 2026, was retired on October 15, 2026. The demo recordings in `assets/demos` still show it.
