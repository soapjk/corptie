#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct { int32_t x, y, width, height; } CorptiePackedRect;
// x/y < 0 means no preferred position. pinnedIndex is reserved first.
int corptie_pack_rectangles(int32_t width, const CorptiePackedRect *items,
    int32_t count, int32_t pinnedIndex, CorptiePackedRect *output);
#ifdef __cplusplus
}
#endif
