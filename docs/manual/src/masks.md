# Masks

`M` opens masking. A mask limits exposure, temperature, contrast, highlights, shadows, saturation and clarity to part of the photo. Up to eight masks are active at once.

| tool | key | |
|---|---|---|
| Linear | `L` | a graduated filter: drag from where it starts to where it is full |
| Radial | `⇧M` | an ellipse: drag its size, then move, rotate and feather it |
| Brush | `K` | paint; `[` and `]` change the size, `Alt` erases |
| Subject | | the main subject, found by a local AI model |
| Sky | | the sky |
| Background | | everything but the subject |
| Object | `B` | click an object, or drag a box around it |

The red wash shows the selected mask; `O` keeps it visible. Touching an adjustment hides it.

**Refine edge** softens an AI mask's edge. **Range** narrows any mask to a band of brightness, or to colours near one you pick.

Brush and AI masks share four slots between them.

The AI models run on your machine, on the GPU when the browser has WebGPU. The first use of each loads it; after that a mask takes well under a second.
