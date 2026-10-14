integer ticks; // Independent timer example.

default
{
    state_entry()
    {
        llSetTimerEvent(2.0);
    }

    timer()
    {
        ++ticks;
    }

    touch_start(integer count)
    {
        llLinksetDataWrite("idle:touch", "yes");
    }
}
