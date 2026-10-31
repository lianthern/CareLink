# Campus geometry work preview — not a finished film segment

Built and rendered locally from existing Three.js modules, using 05-campus-plan.png for north/west/east relationships. West classroom building, north auditorium, east field, south gate and central tree are explicit geometry. Browser page errors: none. Six 1280x720 viewpoint captures plus a 72-frame / 24 fps gate motion proof were rendered and the MP4 fully decoded successfully.

Visual review: initial gate cards were too large; reduced width from 1.25 m to 0.36 m, now about 6% at starting camera. Gate cover re-extracted from S02 with the approved crop=384:216:224:136, removing foreground camera. Classroom desks and blackboard occupy an accessible room with doorway, not a hallway photograph. This classroom is provisional geometry, NOT an approved H3 character reference. Four unused anchors remain explicit blank placeholders; they do not count as sourced memory entrances.

Open work: photographic/material consistency, roof/windows, classroom placement tied to a corrected reference, card orientations for indoor views, valid covers for remaining anchors, event expand/retract transitions, final segment camera paths and continuity. Current camera moves 2.12 m at 1.55 m eye height in three seconds; full route is not yet implemented. Do not label this as S01/S04/S05/S08/S09/S12 complete. Keep the work-preview overlay until final visual acceptance.

Reproduce: node capture.cjs --motion, then ffmpeg -framerate 24 -i motion-frames/%04d.png -c:v libx264 -pix_fmt yuv420p campus-gate-motion-proof.mp4. No new libraries, model weights, cloud rendering or production service changes were required.
