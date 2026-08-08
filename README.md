# Eksport biblioteki lubimyczytac.pl

Skrypt, który zapisuje biblioteczkę z serwisu [lubimyczytac.pl](https://lubimyczytac.pl)
do pliku CSV. \
Nie jest to rozszerzenie do przeglądarki - to jeden plik, który wkleja się
do konsoli przeglądarki i uruchamia.

Przydaje się do zrobienia kopii zapasowej własnych ocen i dat przeczytania,
albo do przeniesienia biblioteczki do innego serwisu (np. [Goodreads](https://www.goodreads.com/review/import)).

- Skrypt czyta wyłącznie dane z zalogowanego na _lubimyczytac.pl_ konta w przeglądarce i zapisuje je na dysku.
  Nic nie jest nigdzie wysyłane - nie ma żadnego serwera ani zewnętrznych adresów.
- Skrypt korzysta z tego samego mechanizmu, z którego korzysta sama strona przy przechodzeniu
  między stronami listy, więc nie obciąża serwisu bardziej niż zwykłe klikanie.

---

## Jak uruchomić

1. Zaloguj się na lubimyczytac.pl i wejdź na stronę **[Biblioteczka](https://lubimyczytac.pl/biblioteczka)**.
2. Przełącz widok na **listę** (a nie na siatkę okładek).
3. Naciśnij **F12**, żeby otworzyć narzędzia deweloperskie, i przejdź na zakładkę **Konsola**
   (ang. *Console*).
4. Otwórz plik [`lc-export.js`](lc-export.js), skopiuj **całą** jego zawartość i wklej do konsoli.
   - Jeżeli przeglądarka poprosi o wpisanie `allow pasting` albo `zezwalaj na wklejanie` -
     wpisz to i naciśnij Enter, a potem wklej skrypt ponownie.
5. Naciśnij **Enter** i poczekaj. W konsoli pojawiają się komunikaty o postępie (przescroluj w dół - konsola może nie przewijać do najnowszych komunikatów).
6. Po zakończeniu przeglądarka sama pobierze plik `lubimyczytac_export.csv`.

Domyślnie eksportowana jest tylko półka **Przeczytane**. Dla ok. 500 książek zajmuje to
około 30 sekund.

---

## Najważniejsze ustawienia

Ustawienia znajdują się na samej górze pliku, w sekcji `const CONFIG = {`.
Zmienia się je **przed** wklejeniem skryptu do konsoli - wystarczy edytować plik w dowolnym
edytorze tekstu (np. Notatniku).

| Opcja | Domyślnie | Co robi |
|---|---|---|
| `shelves` | `['Przeczytane']` | Które półki wyeksportować. Możesz wpisać `'all'` (wszystkie), `'auto'` (te zaznaczone aktualnie na stronie) albo listę nazw, np. `['Przeczytane', 'Teraz czytam']`. Nazwy półek skrypt wypisuje w konsoli na starcie. |
| `includeRating` | `true` | Czy dołączyć twoje oceny (skala 1–10). |
| `includeReview` | `true` | Czy dołączyć twoje recenzje (te widoczne pod książką na liście). |
| `goodreadsFormat` | `false` | `true` przelicza oceny na skalę 1–5, tłumaczy nazwy półek na angielskie (`read`, `to-read`, `currently-reading`) i zapisuje daty jako `RRRR/MM/DD` - czyli przygotowuje plik pod import do Goodreads. |
| `fetchBookPages` | `false` | `true` dociąga **ISBN**, wydawnictwo i rok wydania. Wymaga jednego dodatkowego zapytania na każdą książkę, ze specjalnie ustawionym wolnym tempem zapytań dla 500 pozycji trwa kilkanaście minut. Włącz tylko, jeśli naprawdę potrzebujesz tych informacji. |
| `includeFormat` | `false` | `true` dodaje kolumnę `Binding` z informacją, czy pozycja to `book`, `audiobook` czy `ebook`. |
| `dropEmptyColumns` | `false` | `true` usuwa z pliku kolumny, które w całości pozostały puste (przydatne przy `fetchBookPages: false`). |
| `addBOM` | `false` | `true` ułatwia Excelowi rozpoznanie polskich znaków, ale **może przeszkodzić** przy imporcie do Goodreads. |
| `filename` | `lubimyczytac_export.csv` | Nazwa pobieranego pliku. |

---

## Eksportowane pola

Kolumny odpowiadają formatowi importu Goodreads:

`Title`, `Author`, `ISBN`, `My Rating`, `Average Rating`, `Publisher`,
`Year Published`, `Original Publication Year`, `Date Read`, `Shelves`, `My Review`

Kolumny `ISBN`, `Publisher` i lata wydania są wypełniane tylko przy `fetchBookPages: true` -
w przeciwnym razie pozostają puste.

Plik jest zapisany w kodowaniu UTF-8. Jeżeli otworzysz go w Excelu i zobaczysz krzaczki
zamiast polskich znaków, ustaw `addBOM: true` i wygeneruj plik ponownie
(albo zaimportuj plik w Excelu przez *Dane → Z pliku tekstowego* i wybierz UTF-8).

---

## Import do Goodreads

1. Ustaw `goodreadsFormat: true`.
2. Jeśli zależy Ci na trafnym dopasowaniu wydań, ustaw też `fetchBookPages: true` -
   Goodreads dopasowuje książki przede wszystkim po numerze ISBN.
3. Wygeneruj plik i wgraj go na stronie <https://www.goodreads.com/review/import>.

Goodreads dopasowuje książki automatycznie i nie zawsze trafia idealnie -
po imporcie warto przejrzeć wynik.

---

## Troubleshooting

Po zakończeniu skrypt wypisuje w konsoli tabelkę z liczbą wypełnionych pól
(`title`, `author`, `myRating`, ...). To najszybszy sposób, żeby sprawdzić, czy wszystko się udało.

- **Błąd „No books collected”** - najczęściej oznacza, że nie jesteś na stronie biblioteczki
  albo nie jest włączony widok listy. Sprawdź też, czy na pewno jesteś zalogowany.
- **W tabelce jakieś pole ma `0`** - serwis zmienił wygląd strony i trzeba poprawić skrypt.
  Zgłoś to w zakładce *Issues*; pomocne będzie uruchomienie `copy(__lcSampleCard)` w konsoli
  (kopiuje do schowka kod HTML pierwszej książki z listy) - **przed wysłaniem przejrzyj tę
  zawartość i usuń to, czego nie chcesz publikować**.
- **Komunikaty o błędzie 429** - serwis prosi o zwolnienie tempa. Skrypt sam czeka i ponawia
  próbę (5 s, 15 s, 30 s), więc zwykle wystarczy poczekać. Jeśli powtarza się często,
  zwiększ `bookDelayMs` albo wyłącz `fetchBookPages`.
- **Brak tytułów w niektórych wierszach** - skrypt wypisze numery ID takich pozycji na końcu.

---

## Uwagi

Narzędzie służy do pobrania **własnych** danych z własnego konta - ocen, dat przeczytania
i recenzji. Regulamin lubimyczytac.pl zawiera ogólne zastrzeżenie dotyczące automatycznego
pobierania treści z serwisu, więc korzystaj z tego rozsądnie: nie zwiększaj bez potrzeby
tempa zapytań i nie używaj skryptu do masowego pobierania cudzych biblioteczek ani katalogu książek.

Skrypt powstał jako następca rozszerzenia
[ksiazkowy-exporter](https://github.com/Donkrzawayan/ksiazkowy-exporter), które przestało
działać po zmianie wyglądu serwisu.

Serwis może zmienić swoją stronę w każdej chwili i wtedy skrypt przestanie działać -
to normalne ryzyko przy tego typu narzędziach.
