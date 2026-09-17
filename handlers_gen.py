# -*- coding: utf-8 -*-
import base64
BL = chr(123)
BR = chr(125)
DQ = chr(34)
BN = chr(92)

# We will build the handlers content from chunks
# Each chunk is a small part of the handler code

chunk0 = BL  # placeholder, will be built below
