# Library and culling

## Flags, ratings, labels

| key | |
|---|---|
| `P` `X` `U` | pick, reject, unflag |
| `0`–`5` | rating |
| `6`–`9` | red, yellow, green, blue label |
| `⌫` | delete the selection (after a confirmation) |

The filter bar narrows the grid by flag, rating and label; `⌘F` searches file names, camera, lens, title, caption and keywords.

## Cull, compare, survey

- **Cull** (`⇧C`) shows one photo full screen. A flag or rating key stamps it and moves to the next photo that has no decision yet. The next three photos are prepared in advance.
- **Compare** (`C`) shows the selected photo beside a candidate.
- **Survey** (`N`) lays out the selection side by side.

## Collections

- **Albums** hold any photos you add to them.
- **Smart collections** save a filter and update themselves.
- The **date tree** groups photos by year and month of capture.
- **Keywords**, a title and a caption live in the metadata panel and are searchable.

## Many photos

The grid only draws what is on screen, and the catalog's queries use indexes that match its sorts. A catalog of 10,000 photos filters in about 15 ms; numbers are in the [benchmarks](https://github.com/ZahakJ/albedo/blob/main/docs/BENCHMARKS.md#a-10000-photo-catalog).
