integer responses; // Independent display and dialog example.

default
{
    state_entry()
    {
        llSetText("Root", <1.0, 0.5, 0.25>, 0.75);
    }

    touch_start(integer count)
    {
        llSetLinkPrimitiveParamsFast(
            4,
            [PRIM_TEXT, "Linked", <0.1, 0.2, 0.3>, 0.4]
        );
        llDialog(llGetOwner(), "Choose", ["OK"], -42);
    }

    listen(integer channel, string name, key id, string message)
    {
        ++responses;
    }
}
