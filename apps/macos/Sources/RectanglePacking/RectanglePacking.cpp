#include "RectanglePacking.h"
#include "vendor/MaxRectsBinPack.h"
#include <algorithm>
#include <vector>

int corptie_pack_rectangles(int32_t width, const CorptiePackedRect *items,
    int32_t count, int32_t pinnedIndex, CorptiePackedRect *output) {
    if (width <= 0 || width > 32768 || count < 0 || count > 1024) return 0;
    if (count == 0) return 1;
    if (!items || !output) return 0;
    int64_t height = 0, previousBottom = 0;
    for (int i = 0; i < count; ++i) {
        if (items[i].width <= 0 || items[i].width > width ||
            items[i].height <= 0 || items[i].height > 1000000) return 0;
        height += items[i].height;
        if (items[i].y >= 0) previousBottom = std::max(previousBottom,
            int64_t(items[i].y) + items[i].height);
    }
    height += previousBottom;
    if (height > 100000000) return 0;
    try {
        rbp::MaxRectsBinPack packer(width, int(height), false);
        std::vector<bool> placed(count, false);
        auto reserve = [&](int i) {
            const auto &item = items[i];
            rbp::Rect rect{item.x, item.y, item.width, item.height};
            if (packer.Reserve(rect)) { output[i] = item; placed[i] = true; }
        };
        if (pinnedIndex >= 0 && pinnedIndex < count) reserve(pinnedIndex);
        for (int i = 0; i < count; ++i) if (!placed[i]) reserve(i);
        for (int i = 0; i < count; ++i) if (!placed[i]) {
            auto rect = packer.Insert(items[i].width, items[i].height,
                rbp::MaxRectsBinPack::RectBottomLeftRule);
            if (rect.height == 0) return 0;
            output[i] = {rect.x, rect.y, rect.width, rect.height};
        }
        return 1;
    } catch (...) { return 0; }
}
