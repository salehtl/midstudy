"""midstudy furniture pipeline: `midstudy-add` (see contract/CONTRACT.md §3)."""


class MidstudyError(Exception):
    """A failure the user can act on. The message is printed as one line on stderr."""
