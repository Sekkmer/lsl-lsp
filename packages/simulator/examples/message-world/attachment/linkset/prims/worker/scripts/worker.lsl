// Original minimal simulator example. SPDX-License-Identifier: MIT
default
{
    link_message(integer sender, integer number, string message, key id)
    {
        if (number == 200)
        {
            llLinksetDataWrite("worker:received", message);
            llMessageLinked(LINK_ROOT, 201, "pong", id);
        }
    }
}
