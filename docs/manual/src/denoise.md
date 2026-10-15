# AI Denoise

*AI Denoise* in the Detail section removes noise with a neural network that works on the RAW data itself, before demosaicing, the way the sensor recorded it. It keeps fine detail that ordinary noise reduction smooths away.

Moving the slider above 0 starts it; a 45-megapixel photo takes a few seconds on a discrete GPU, and the progress shows under the slider. The slider then sets how much of the denoised image is used, without running the model again.

It works on Bayer sensors. X-Trans and other sensors keep the regular noise reduction, which AI Denoise replaces while it is on.

Exports wait for a denoise that is still running.
