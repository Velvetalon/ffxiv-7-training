#include <hkxparse/HKXMapping.h>
#include <hkxparse/HKXTagfileParser.h>
#include "hka_spline_decompressor.hpp"

#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <unordered_set>

using namespace hkxparse;

static bool hasClass(const HKXStruct &value, const std::string &name) {
    for (const auto &item : value.classNames) if (item == name) return true;
    return false;
}

static HKXStruct *findClass(HKXVariant &value, const std::string &name,
                            std::unordered_set<HKXStruct *> &visited) {
    if (auto ref = std::get_if<HKXStructRef>(&value)) {
        if (!*ref || !visited.insert(ref->get()).second) return nullptr;
        if (hasClass(**ref, name)) return ref->get();
        for (auto &[_, field] : (*ref)->fields)
            if (auto found = findClass(field, name, visited)) return found;
    } else if (auto object = std::get_if<HKXStruct>(&value)) {
        if (hasClass(*object, name)) return object;
        for (auto &[_, field] : object->fields)
            if (auto found = findClass(field, name, visited)) return found;
    } else if (auto array = std::get_if<HKXArray>(&value)) {
        for (auto &item : array->values)
            if (auto found = findClass(item, name, visited)) return found;
    }
    return nullptr;
}

static uint32_t uintField(HKXStruct &object, const char *name) {
    return static_cast<uint32_t>(std::get<uint64_t>(object.fields.at(name)));
}

static float floatField(HKXStruct &object, const char *name) {
    return std::get<float>(object.fields.at(name));
}

static std::vector<uint32_t> uintArray(HKXStruct &object, const char *name) {
    std::vector<uint32_t> result;
    for (auto &item : std::get<HKXArray>(object.fields.at(name)).values)
        result.push_back(static_cast<uint32_t>(std::get<uint64_t>(item)));
    return result;
}

static std::vector<int32_t> intArray(HKXStruct &object, const char *name) {
    std::vector<int32_t> result;
    for (auto &item : std::get<HKXArray>(object.fields.at(name)).values)
        result.push_back(static_cast<int32_t>(std::get<uint64_t>(item)));
    return result;
}

int main(int argc, char **argv) {
    if (argc != 3) {
        std::cerr << "usage: spline_probe <animation-tagfile> <output-csv>\n";
        return 2;
    }
    try {
        std::ifstream input(argv[1], std::ios::binary | std::ios::ate);
        if (!input) throw std::runtime_error("cannot open input");
        const size_t size = static_cast<size_t>(input.tellg());
        input.seekg(0);
        HKXMapping mapping(size);
        input.read(reinterpret_cast<char *>(mapping.data()), static_cast<std::streamsize>(size));

        HKXTagfileParser parser(mapping);
        HKXVariant root = parser.parse();
        std::unordered_set<HKXStruct *> visited;
        HKXStruct *animation = findClass(root, "hkaSplineCompressedAnimation", visited);
        visited.clear();
        HKXStruct *binding = findClass(root, "hkaAnimationBinding", visited);
        if (!animation || !binding) throw std::runtime_error("animation or binding not found");

        const uint32_t numTracks = uintField(*animation, "numberOfTransformTracks");
        const uint32_t numFrames = uintField(*animation, "numFrames");
        const uint32_t numBlocks = uintField(*animation, "numBlocks");
        const float duration = floatField(*animation, "duration");
        const float blockDuration = floatField(*animation, "blockDuration");
        const float blockInverseDuration = floatField(*animation, "blockInverseDuration");
        const float frameDuration = floatField(*animation, "frameDuration");
        const uint32_t frameRate = static_cast<uint32_t>(numFrames / duration);
        const auto blockOffsets = uintArray(*animation, "blockOffsets");
        const auto trackToBone = intArray(*binding, "transformTrackToBoneIndices");
        auto data = std::get<std::vector<unsigned char>>(animation->fields.at("data"));

        if (blockOffsets.size() != numBlocks) throw std::runtime_error("block offset count mismatch");
        if (trackToBone.size() != numTracks) throw std::runtime_error("binding track count mismatch");

        std::vector<TransformSplineBlock> blocks(numBlocks);
        for (uint32_t index = 0; index < numBlocks; ++index)
            blocks[index].Assign(reinterpret_cast<char *>(data.data()) + blockOffsets[index], numTracks, 0);

        std::ofstream output(argv[2], std::ios::out | std::ios::trunc);
        output << "frame,time,track,bone,tx,ty,tz,qx,qy,qz,qw,sx,sy,sz\n";
        output << std::setprecision(9);
        size_t nonFinite = 0;
        float minQuatNorm = 1000.f, maxQuatNorm = 0.f;
        for (uint32_t frame = 0; frame < numFrames; ++frame) {
            const float time = std::min(duration, frame * frameDuration);
            size_t block = static_cast<size_t>(time * blockInverseDuration);
            if (block >= blocks.size()) block = blocks.size() - 1;
            float localTime = std::max(0.f, time - static_cast<float>(block) * blockDuration);
            const float localFrame = localTime * frameRate;
            for (uint32_t track = 0; track < numTracks; ++track) {
                hkQTransform value;
                blocks[block].GetValue(track, localFrame, value);
                const float qnorm = std::sqrt(value.rotation.X * value.rotation.X +
                                              value.rotation.Y * value.rotation.Y +
                                              value.rotation.Z * value.rotation.Z +
                                              value.rotation.W * value.rotation.W);
                minQuatNorm = std::min(minQuatNorm, qnorm);
                maxQuatNorm = std::max(maxQuatNorm, qnorm);
                const float values[] = {value.translation.X, value.translation.Y, value.translation.Z,
                                        value.rotation.X, value.rotation.Y, value.rotation.Z, value.rotation.W,
                                        value.scale.X, value.scale.Y, value.scale.Z};
                for (float component : values) if (!std::isfinite(component)) ++nonFinite;
                output << frame << ',' << time << ',' << track << ',' << trackToBone[track] << ','
                       << value.translation.X << ',' << value.translation.Y << ',' << value.translation.Z << ','
                       << value.rotation.X << ',' << value.rotation.Y << ',' << value.rotation.Z << ',' << value.rotation.W << ','
                       << value.scale.X << ',' << value.scale.Y << ',' << value.scale.Z << '\n';
            }
        }

        std::cout << "frames=" << numFrames << " tracks=" << numTracks
                  << " samples=" << static_cast<uint64_t>(numFrames) * numTracks
                  << " duration=" << duration << " frameRate=" << frameRate
                  << " nonFinite=" << nonFinite
                  << " quatNormRange=" << minQuatNorm << ".." << maxQuatNorm << '\n';
        return nonFinite == 0 ? 0 : 3;
    } catch (const std::exception &error) {
        std::cerr << "decode failed: " << error.what() << '\n';
        return 1;
    }
}
