"""Сумма прописью на русском (для печатной формы счёта)."""
from decimal import Decimal

_ONES_M = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"]
_ONES_F = ["", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"]
_TEENS = ["десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать",
          "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать"]
_TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"]
_HUNDREDS = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"]


def _plural(n: int, forms: tuple[str, str, str]) -> str:
    """forms = (1, 2-4, 5-0), напр. ('рубль','рубля','рублей')."""
    n = abs(n) % 100
    if 10 < n < 20:
        return forms[2]
    d = n % 10
    if d == 1:
        return forms[0]
    if 2 <= d <= 4:
        return forms[1]
    return forms[2]


def _triple(n: int, female: bool) -> list[str]:
    ones = _ONES_F if female else _ONES_M
    words: list[str] = []
    h, rest = divmod(n, 100)
    if h:
        words.append(_HUNDREDS[h])
    if 10 <= rest < 20:
        words.append(_TEENS[rest - 10])
    else:
        t, o = divmod(rest, 10)
        if t:
            words.append(_TENS[t])
        if o:
            words.append(ones[o])
    return words


def _int_in_words(n: int) -> str:
    if n == 0:
        return "ноль"
    parts: list[str] = []
    # миллиарды, миллионы, тысячи, единицы
    groups = [
        (1_000_000_000, False, ("миллиард", "миллиарда", "миллиардов")),
        (1_000_000, False, ("миллион", "миллиона", "миллионов")),
        (1_000, True, ("тысяча", "тысячи", "тысяч")),
    ]
    for base, female, forms in groups:
        g, n = divmod(n, base)
        if g:
            parts += _triple(g, female)
            parts.append(_plural(g, forms))
    if n:
        parts += _triple(n, False)
    return " ".join(p for p in parts if p)


def rubles_in_words(amount: Decimal) -> str:
    """Например: 1234.50 → «Одна тысяча двести тридцать четыре рубля 50 копеек»."""
    amount = Decimal(amount).quantize(Decimal("0.01"))
    rub = int(amount)
    kop = int((amount - rub) * 100)
    words = _int_in_words(rub)
    words = words[0].upper() + words[1:]
    return f"{words} {_plural(rub, ('рубль', 'рубля', 'рублей'))} {kop:02d} {_plural(kop, ('копейка', 'копейки', 'копеек'))}"
