ЗВУКИ CROWN CASINO — положи сюда настоящие файлы (mp3 / ogg / wav / m4a / webm), перезапуск не нужен.

ИМЯ ФАЙЛА:  <игра>_<событие>.mp3        (несколько вариантов: <игра>_<событие>_1.mp3, _2.mp3 … — играется случайный)
ИГРЫ:       slots, roulette, dice, crash, mines, flappy, crypto, upgrader, ui
ОБЩИЕ СОБЫТИЯ (есть у любой игры):  click, tick, win, lose, coin, explosion
ОСОБЫЕ:     crash_launch (старт), crash_crash (отказ двигателя), crash_explosion (удар о землю),
            flappy_flap (взмах), flappy_score (очко), mines_gem (безопасная клетка)

ПОРЯДОК ПОИСКА:  <игра>_<событие>  →  общий <событие>  →  запасной синтезированный звук (у каждой игры свой).
Т.е. можно положить всего 6 общих файлов (click, tick, win, lose, coin, explosion) — и звуки уже перестанут быть писками;
а потом по одному добавлять уникальные для игр.

ЧТО ИСКАТЬ (всё это бесплатные паки с лицензией CC0 — можно использовать в игре без оплаты и без обязательной ссылки):
  • Kenney «Casino Audio»  (kenney.nl/assets/casino-audio)   — фишки, карты, кубики → slots_*, roulette_*, dice_*, coin
  • Kenney «Interface Sounds» (kenney.nl/assets/interface-sounds) — клики, подтверждения, ошибки → click, tick, win, lose, mines_gem, flappy_score
  • Kenney «Sci-Fi Sounds»  (kenney.nl/assets/sci-fi-sounds)   — двигатель, взрывы → crash_launch, crash_crash, crash_explosion, explosion
  • Kenney «Impact Sounds»  (kenney.nl/assets/impact-sounds)   — удары, глухие стуки → flappy_lose, roulette_lose
  Если берёшь звуки с freesound.org / opengameart.org — выбирай только лицензию CC0 (или CC-BY с указанием автора). NC не подходит.
Имена файлов внутри паков отличаются — просто переименуй под схему выше.
Громкость: файлы лучше нормализовать (примерно −12 dBFS), короткие (до 2–3 секунд, взрыв/запуск до 4).
