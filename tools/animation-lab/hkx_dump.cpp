#include <hkxparse/HKXMapping.h>
#include <hkxparse/HKXTagfileParser.h>
#include <hkxparse/PrettyPrinter.h>

#include <cstring>
#include <fstream>
#include <iostream>
#include <stdexcept>

int main(int argc, char **argv) {
    if (argc != 3) {
        std::cerr << "usage: hkx_dump <input-tagfile> <output-text>\n";
        return 2;
    }

    try {
        std::ifstream input(argv[1], std::ios::binary | std::ios::ate);
        if (!input) throw std::runtime_error("cannot open input");
        const auto end = input.tellg();
        if (end <= 0) throw std::runtime_error("empty input");
        const auto size = static_cast<size_t>(end);
        input.seekg(0);

        hkxparse::HKXMapping mapping(size);
        input.read(reinterpret_cast<char *>(mapping.data()), static_cast<std::streamsize>(size));
        if (!input) throw std::runtime_error("failed to read input");

        hkxparse::HKXTagfileParser parser(mapping);
        auto root = parser.parse();

        std::ofstream output(argv[2], std::ios::out | std::ios::trunc);
        if (!output) throw std::runtime_error("cannot open output");
        hkxparse::PrettyPrinter printer(output);
        printer.print(root);
        std::cout << "parsed " << size << " bytes into " << argv[2] << "\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "parse failed: " << error.what() << "\n";
        return 1;
    }
}
