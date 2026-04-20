"""UK (England & Wales) working days: Monday–Friday excluding bank holidays.

Bank holidays follow the standard England & Wales pattern (gov.uk): Easter (computed),
fixed Monday rules for May and August, New Year and Christmas/Boxing observed when they
fall on weekends (same substitution pattern as UK banking legislation / common calendars).
Spring bank holiday uses the usual “last Monday in May” rule except for known one-off
years (e.g. jubilee shifts). One-off extra days (coronations, funerals) are not predicted.
"""

from __future__ import annotations

import calendar
from datetime import date, timedelta


def _easter_sunday(year: int) -> date:
    """Anonymous Gregorian algorithm (Meeus)."""
    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def _new_year_observed(year: int) -> date:
    """New Year's Day; weekend → next Monday (Sat +2, Sun +1)."""
    d = date(year, 1, 1)
    wd = d.weekday()
    if wd == 5:
        return d + timedelta(days=2)
    if wd == 6:
        return d + timedelta(days=1)
    return d


def _sat_sun_to_next_mon_tue(d: date) -> date:
    """Christmas / Boxing-style substitution: Sat or Sun → +2 working days (Mon / Tue)."""
    wd = d.weekday()
    if wd in (5, 6):
        return d + timedelta(days=2)
    return d


def _first_weekday_on_or_after(d: date, weekday: int) -> date:
    """weekday: Mon=0 … Sun=6."""
    delta = (weekday - d.weekday()) % 7
    return d + timedelta(days=delta)


def _first_monday_in_month(year: int, month: int) -> date:
    return _first_weekday_on_or_after(date(year, month, 1), 0)


def _last_monday_in_month(year: int, month: int) -> date:
    last = date(year, month, calendar.monthrange(year, month)[1])
    delta = (last.weekday() - 0) % 7
    return last - timedelta(days=delta)


# Early May bank holiday: normally first Monday in May; VE / special years used fixed dates.
_EARLY_MAY_EXCEPTION: dict[int, date] = {
    1995: date(1995, 5, 8),
    2020: date(2020, 5, 8),
}

# Spring bank holiday: normally last Monday in May; jubilee years used fixed June dates.
_SPRING_BANK_EXCEPTION: dict[int, date] = {
    2002: date(2002, 6, 4),
    2012: date(2012, 6, 4),
    2022: date(2022, 6, 2),
}


def _early_may_bank_holiday(year: int) -> date:
    return _EARLY_MAY_EXCEPTION.get(year, _first_monday_in_month(year, 5))


def _spring_bank_holiday(year: int) -> date:
    return _SPRING_BANK_EXCEPTION.get(year, _last_monday_in_month(year, 5))


def england_wales_bank_holidays(year: int) -> frozenset[date]:
    """All England & Wales bank holidays for ``year`` (standard rules + known exceptions)."""
    es = _easter_sunday(year)
    s = {
        _new_year_observed(year),
        es - timedelta(days=2),
        es + timedelta(days=1),
        _early_may_bank_holiday(year),
        _spring_bank_holiday(year),
        _last_monday_in_month(year, 8),
        _sat_sun_to_next_mon_tue(date(year, 12, 25)),
        _sat_sun_to_next_mon_tue(date(year, 12, 26)),
    }
    return frozenset(s)


def is_uk_business_day(d: date) -> bool:
    if d.weekday() >= 5:
        return False
    return d not in england_wales_bank_holidays(d.year)
