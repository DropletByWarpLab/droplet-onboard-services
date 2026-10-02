from tool import run


def test_counts_words_and_characters():
    assert run({"text": "two words"}) == {"words": 2, "characters": 9}


def test_empty_text_is_zero_words():
    assert run({"text": "   "}) == {"words": 0, "characters": 3}
