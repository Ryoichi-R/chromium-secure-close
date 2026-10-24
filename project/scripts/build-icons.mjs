import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const iconDir = resolve(root, 'extension/icons');
const sizes = [16, 32, 48, 128];

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const typeBuffer = Buffer.from(type, 'ascii');
    const output = Buffer.alloc(12 + data.length);
    output.writeUInt32BE(data.length, 0);
    typeBuffer.copy(output, 4);
    data.copy(output, 8);
    output.writeUInt32BE(
        crc32(Buffer.concat([typeBuffer, data])),
        8 + data.length,
    );
    return output;
}

function png(size) {
    const rgba = Buffer.alloc(size * size * 4, 0);
    const set = (x, y, red, green, blue, alpha = 255) => {
        if (x < 0 || y < 0 || x >= size || y >= size) return;
        const offset = (y * size + x) * 4;
        rgba[offset] = red;
        rgba[offset + 1] = green;
        rgba[offset + 2] = blue;
        rgba[offset + 3] = alpha;
    };
    const scale = size / 16;
    const draw = (x, y, width, height, color) => {
        for (
            let row = Math.floor(y * scale);
            row < Math.ceil((y + height) * scale);
            row += 1
        ) {
            for (
                let col = Math.floor(x * scale);
                col < Math.ceil((x + width) * scale);
                col += 1
            )
                set(col, row, ...color);
        }
    };
    const blue = [35, 99, 235, 255];
    const dark = [15, 23, 42, 255];
    draw(2, 7, 9, 6, blue);
    draw(5, 4, 5, 4, blue);
    draw(9, 8, 5, 2, dark);
    draw(12, 6, 2, 6, dark);
    draw(10, 10, 4, 2, dark);
    draw(8, 12, 6, 2, dark);
    const rows = [];
    const stride = size * 4;
    for (let row = 0; row < size; row += 1)
        rows.push(
            Buffer.concat([
                Buffer.from([0]),
                rgba.subarray(row * stride, (row + 1) * stride),
            ]),
        );
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;
    header[9] = 6;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

await mkdir(iconDir, { recursive: true });
for (const size of sizes)
    await writeFile(resolve(iconDir, `icon${size}.png`), png(size));
console.log(
    `Generated ${sizes.length} PNG icons in ${dirname(resolve(iconDir, 'icon16.png'))}`,
);
