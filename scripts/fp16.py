# fp16.py IN OUT — weight-only half precision for the browser: every float32
# initializer is stored as float16 and cast back to float32 inside the graph.
# The file is half the size; onnxruntime folds the casts when it loads the
# model, so inference runs in float32 and needs no shader-f16 support (which
# many GPUs, e.g. Vulkan on Linux, do not expose to WebGPU). Only the first
# output is kept: U²-Net-style models carry side outputs nobody reads.
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

m = onnx.load(sys.argv[1])
g = m.graph
first = g.output[0]
del g.output[:]
g.output.append(first)

casts = []
for init in g.initializer:
    if init.data_type != TensorProto.FLOAT:
        continue
    arr = numpy_helper.to_array(init)
    if arr.size < 16:  # scalars and tiny shapes: not worth a cast node
        continue
    half = numpy_helper.from_array(arr.astype(np.float16), init.name + '__f16')
    init.CopyFrom(half)
    casts.append(helper.make_node('Cast', [init.name], [init.name[:-5]], to=TensorProto.FLOAT))
nodes = list(g.node)
del g.node[:]
g.node.extend(casts + nodes)
onnx.save(m, sys.argv[2])
